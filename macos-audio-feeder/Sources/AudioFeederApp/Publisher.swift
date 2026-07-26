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
        didSet { if state != oldValue { onStateChange?(state) } }
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
            let token = try await LiveKitTokenClient(serverURL: serverURL).fetchToken(room: docID)
            if Task.isCancelled { return }

            let room = Room()
            try await room.connect(url: token.serverUrl, token: token.token)
            if Task.isCancelled { try? await room.disconnect(); return }

            try AudioManager.shared.setManualRenderingMode(true)
            try await room.localParticipant.setMicrophone(enabled: true)

            self.room = room
            state = .connected
        } catch {
            state = .failed("\(error)")
        }
    }
}
