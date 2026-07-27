import Foundation
import AVFoundation
import LiveKit
import AudioFeederCore

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
@MainActor
final class Publisher {
    enum State: Equatable {
        case disconnected
        case connecting
        case connected
        case failed(String)
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
    private var room: Room?
    private var connectTask: Task<Void, Never>?

    init(serverURL: String) {
        self.serverURL = serverURL
    }

    /// Connect to `room` (the doc id) and publish. Idempotent while connected/connecting.
    func start(room docID: String) {
        guard case .disconnected = state else { return }
        state = .connecting
        connectTask = Task { await self.connect(docID: docID) }
    }

    /// Feed one captured mono buffer to the publish mixer. No-op until connected.
    func capture(_ buffer: AVAudioPCMBuffer) {
        guard case .connected = state else { return }
        AudioManager.shared.mixer.capture(appAudio: buffer)
    }

    /// Stop publishing and disconnect so the `organizer-host` identity is released for the
    /// browser broadcast path.
    func stop() {
        connectTask?.cancel()
        connectTask = nil
        let room = self.room
        self.room = nil
        state = .disconnected
        Task {
            try? AudioManager.shared.setManualRenderingMode(false)
            try? await room?.disconnect()
        }
    }

    private func connect(docID: String) async {
        do {
            Log.publisher.notice("fetching token from \(self.serverURL, privacy: .public) for room \(docID, privacy: .public)")
            let token = try await LiveKitTokenClient(serverURL: serverURL).fetchToken(room: docID)
            if Task.isCancelled { return }
            Log.publisher.notice("token OK; connecting to \(token.serverUrl, privacy: .public)")

            let room = Room()
            try await room.connect(url: token.serverUrl, token: token.token)
            if Task.isCancelled { try? await room.disconnect(); return }
            Log.publisher.notice("room connected")

            try AudioManager.shared.setManualRenderingMode(true)
            try await room.localParticipant.setMicrophone(enabled: true)
            Log.publisher.notice("publishing as \(LiveKitTokenClient.organizerIdentity, privacy: .public)")

            self.room = room
            state = .connected
        } catch {
            // The full error, not just the UI summary. A `Room.connect` failure here is the
            // difference between "no network", "token endpoint 503", and "ICE never
            // completed" — and only this line can tell them apart after the fact.
            Log.publisher.error("connect failed: \(String(describing: error), privacy: .public)")
            state = .failed("\(error)")
        }
    }
}
