import Foundation
import AVFoundation
import LiveKit
import AudioFeederCore

/// What the room told us about itself, normalized off the SDK's delegate queue.
///
/// Deliberately declared at file scope rather than nested in `Publisher`: `Publisher` is
/// `@MainActor`, and this type has to be constructed on the SDK's own dispatch queue before
/// being handed to the main actor.
enum RoomEvent: Sendable {
    /// The SDK is re-establishing a connection that was already up. It does this on its own
    /// for transient network trouble; nothing is publishing while it lasts.
    case reconnecting
    /// The SDK got it back. Audio flows again.
    case reconnected
    /// The connection ended and the SDK is not going to recover it.
    case dropped(DisconnectCause)
}

/// Publishes captured mono audio into the session's LiveKit room as `organizer-host`,
/// reusing the live-notes token endpoint. Mirrors the browser broadcast contract, so the
/// server needs no changes and the browser page remains a valid alternative input.
///
/// Uses the SDK's custom-audio path (validated end-to-end on real hardware): manual
/// rendering mode so the physical mic is never opened, and `mixer.capture(appAudio:)` to
/// feed our buffers. If a future LiveKit SDK upgrade breaks `setManualRenderingMode` /
/// `mixer.capture(appAudio:)` (see the SDK's `Docs/audio.md`), the fallback is to expose the
/// desired channel as its own input device via a macOS Aggregate Device and use the SDK's
/// normal device capture — still pure Swift.
///
/// The publisher **observes** the room rather than assuming it stays up. Without a
/// `RoomDelegate`, `state` was only ever written by our own `connect()`/`stop()`, so once it
/// reached `.connected` it stayed there for the lifetime of the object no matter what the
/// room did — the menu bar said "Publishing" into a dead room (issue #97).
@MainActor
final class Publisher {
    enum State: Equatable {
        case disconnected
        case connecting
        case connected
        /// Was connected; the SDK is trying to get it back.
        case reconnecting
        /// The connect attempt failed.
        case failed(String)
        /// An established connection ended. The cause decides whether to come back — see
        /// `DisconnectPolicy`.
        case dropped(DisconnectCause)
    }

    private(set) var state: State = .disconnected {
        didSet {
            guard state != oldValue else { return }
            Log.publisher.notice("state \(String(describing: oldValue), privacy: .public) -> \(String(describing: self.state), privacy: .public)")
            onStateChange?(state)
        }
    }
    var onStateChange: ((State) -> Void)?

    private let serverURL: String
    private let writeKey: String?
    private var room: Room?
    private var connectTask: Task<Void, Never>?

    /// The SDK's `MulticastDelegate` holds delegates **weakly**, so the observer has to be
    /// owned here or it would be collected the moment `connect()` returned.
    private var observer: RoomObserver?

    /// Bumped by every `start()` and `stop()`. Room callbacks carry the value they were
    /// registered with, so events from a session we already walked away from are ignored —
    /// notably the `didDisconnectWithError(nil)` that our own `stop()` provokes.
    private var sessionID: Int = 0

    init(serverURL: String, writeKey: String? = nil) {
        self.serverURL = serverURL
        self.writeKey = writeKey
    }

    /// Connect to `room` (the doc id) and publish. Idempotent while connected/connecting.
    func start(room docID: String) {
        guard state == .disconnected else { return }
        sessionID &+= 1
        let id = sessionID
        state = .connecting
        connectTask = Task { await self.connect(docID: docID, sessionID: id) }
    }

    /// Feed one captured mono buffer to the publish mixer. No-op until connected.
    func capture(_ buffer: AVAudioPCMBuffer) {
        guard state == .connected else { return }
        AudioManager.shared.mixer.capture(appAudio: buffer)
    }

    /// Stop publishing and disconnect so the `organizer-host` identity is released for the
    /// browser broadcast path.
    func stop() {
        sessionID &+= 1                  // invalidate in-flight room callbacks
        connectTask?.cancel()
        connectTask = nil
        let room = self.room
        self.room = nil
        observer = nil
        state = .disconnected
        Task {
            try? AudioManager.shared.setManualRenderingMode(false)
            await room?.disconnect()
        }
    }

    /// True while this connect attempt still speaks for the publisher. Every `await` below is
    /// a chance for `stop()` to have happened, and a task that has been superseded must not
    /// write `state` — otherwise a deliberate stop reports itself as a connection failure and
    /// earns a retry nobody asked for.
    private func isCurrent(_ id: Int) -> Bool { id == sessionID && !Task.isCancelled }

    private func connect(docID: String, sessionID id: Int) async {
        var pending: Room?
        do {
            Log.publisher.notice("fetching token from \(self.serverURL, privacy: .public) for room \(docID, privacy: .public)")
            let token = try await LiveKitTokenClient(serverURL: serverURL, writeKey: writeKey)
                .fetchToken(room: docID)
            guard isCurrent(id) else { return }
            Log.publisher.notice("token OK; connecting to \(token.serverURL, privacy: .public)")

            let room = Room()
            pending = room

            // Register before connecting, so nothing between here and `.connected` is missed.
            let observer = RoomObserver { [weak self] event in
                Task { @MainActor in self?.handle(event, sessionID: id) }
            }
            self.observer = observer
            room.add(delegate: observer)

            try await room.connect(url: token.serverURL, token: token.token)
            guard isCurrent(id) else { await room.disconnect(); return }
            Log.publisher.notice("room connected")

            try AudioManager.shared.setManualRenderingMode(true)
            try await room.localParticipant.setMicrophone(enabled: true)
            guard isCurrent(id) else { await room.disconnect(); return }
            Log.publisher.notice("publishing as \(LiveKitTokenClient.organizerIdentity, privacy: .public)")

            // The room can drop while we are still setting up — the observer has already
            // fired by then, and announcing `.connected` now would wedge us in a dead room
            // with nothing left to tell us otherwise.
            guard room.connectionState == .connected else {
                throw LiveKitError(.invalidState,
                                   message: "room went \(String(describing: room.connectionState)) during publish setup")
            }

            self.room = room
            state = .connected
        } catch {
            // The full error, not just the UI summary. A `Room.connect` failure here is the
            // difference between "no network", "token endpoint 503", and "ICE never
            // completed" — and only this line can tell them apart after the fact.
            Log.publisher.error("connect failed: \(String(describing: error), privacy: .public)")
            // Release the half-built room; leaving it connected would hold the
            // `organizer-host` identity against the retry that is about to follow.
            await pending?.disconnect()
            guard isCurrent(id) else { return }
            observer = nil
            state = .failed("\(error)")
        }
    }

    private func handle(_ event: RoomEvent, sessionID id: Int) {
        guard id == sessionID else { return }   // a room we've already walked away from

        switch event {
        case .reconnecting:
            guard state == .connected else { return }
            state = .reconnecting
        case .reconnected:
            guard state == .reconnecting else { return }
            state = .connected
        case let .dropped(cause):
            Log.publisher.error("room dropped: \(cause.description, privacy: .public)")
            room = nil
            observer = nil
            state = .dropped(cause)
        }
    }
}

/// Bridges `RoomDelegate` to the main-actor `Publisher`.
///
/// Three constraints force this to be a separate object rather than a conformance on
/// `Publisher`: `RoomDelegate` is an `@objc` protocol (so the conformer must be an
/// `NSObject`), its methods are called on the SDK's own dispatch queue and explicitly *not*
/// the main thread, and the SDK holds delegates weakly. So this stays unisolated, converts
/// everything it is handed into `Sendable` values while still on the SDK's queue — neither
/// `Room` nor, on older SDKs, `LiveKitError` is `Sendable` — and hands only those across.
private final class RoomObserver: NSObject, RoomDelegate {
    private let onEvent: @Sendable (RoomEvent) -> Void

    init(onEvent: @escaping @Sendable (RoomEvent) -> Void) {
        self.onEvent = onEvent
    }

    func roomIsReconnecting(_: Room) {
        onEvent(.reconnecting)
    }

    func roomDidReconnect(_: Room) {
        onEvent(.reconnected)
    }

    /// Fired when a connection that had succeeded goes away for good. The SDK handles
    /// transient network trouble itself (resume / full reconnect) and only lands here once it
    /// has given up, or when the server sends a terminal leave — which is what an eviction
    /// by duplicate identity looks like from the client.
    func room(_: Room, didDisconnectWithError error: LiveKitError?) {
        onEvent(.dropped(Self.cause(for: error)))
    }

    /// The `default` arm is deliberate rather than an oversight: `LiveKitErrorType` has ~35
    /// cases, all but a handful of them irrelevant here. It costs the compile error an SDK
    /// upgrade would otherwise raise — the trade is made knowingly, and anything new lands on
    /// `.unknown`, which `DisconnectPolicy` retries.
    private static func cause(for error: LiveKitError?) -> DisconnectCause {
        guard let error else {
            // `Room.disconnect()` cleans up with no error. Reaching here means a disconnect
            // we did not ask for and the server did not explain.
            return .unknown("no error reported")
        }
        switch error.type {
        case .duplicateIdentity: return .duplicateIdentity
        case .participantRemoved: return .participantRemoved
        case .serverShutdown: return .serverShutdown
        case .roomDeleted: return .roomDeleted
        case .network, .serverPingTimedOut, .timedOut: return .connectionLost("\(error.type)")
        default: return .unknown("\(error)")
        }
    }
}
