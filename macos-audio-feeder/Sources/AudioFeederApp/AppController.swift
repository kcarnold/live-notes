import Foundation
import AVFoundation
import Combine
import CoreAudio
import AudioFeederCore

/// Orchestrates the feeder: evaluates the schedule, manages the capture→publish lifecycle,
/// handles device presence/hot-plug, and exposes observable state for the menu-bar UI.
@MainActor
final class AppController: ObservableObject {

    /// High-level status surfaced in the UI.
    enum Status: Equatable {
        case idle                    // schedule says off
        case waitingForDevice(String)
        case connecting
        case publishing
        case reconnecting            // was publishing; the room dropped and we're coming back
        case standby(String)         // stopped on purpose and *not* retrying — see standDown
        case error(String)

        var label: String {
            switch self {
            case .idle: return "Idle (off schedule)"
            case let .waitingForDevice(name): return "Waiting for device: \(name)"
            case .connecting: return "Connecting…"
            case .publishing: return "Publishing"
            case .reconnecting: return "Reconnecting…"
            case let .standby(reason): return "Stopped — \(reason)"
            case let .error(msg): return "Error: \(msg)"
            }
        }
    }

    @Published private(set) var status: Status = .idle {
        didSet {
            guard status != oldValue else { return }
            Log.controller.notice("status: \(self.status.label, privacy: .public)")
        }
    }
    @Published private(set) var level: Float = 0          // 0...1 for the meter
    @Published private(set) var devices: [AudioInputDevice] = []

    /// Non-nil while we are deliberately staying down after a disconnect that retrying would
    /// only make worse (`DisconnectPolicy`). Cleared by an explicit human action or by the
    /// end of the run window — never by the retry timer, which is the whole point.
    @Published private(set) var standDown: String?

    @Published var config: FeederConfig {
        didSet { configChanged() }
    }

    private let store = ConfigStore()
    private let deviceMonitor = DeviceMonitor()
    private var capture: AudioCapture?
    private var publisher: Publisher?

    private var tick: Timer?
    private var retryTimer: Timer?
    private var retryAfter: Date?
    private var retryBackoff: TimeInterval = 2

    init() {
        self.config = store.load()
        refreshDevices()

        Log.controller.notice("""
            launched; server \(self.config.serverURL, privacy: .public), \
            room \(self.config.resolvedDocID(), privacy: .public), \
            \(self.devices.count, privacy: .public) input device(s)
            """)

        deviceMonitor.onDevicesChanged = { [weak self] in
            guard let self else { return }
            self.refreshDevices()
            Log.devices.notice("""
                hot-plug: now \(self.devices.count, privacy: .public) input device(s) — \
                \(self.devices.map(\.name).joined(separator: ", "), privacy: .public)
                """)
            self.evaluate()
        }
        deviceMonitor.startMonitoring()

        // Re-evaluate on a coarse cadence so scheduled windows start/stop on time.
        tick = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluate() }
        }
        evaluate()
    }

    // MARK: - Manual override (UI buttons)

    func startNow() {
        clearStandDown()
        config.manualOverride = .forceOn                   // didSet → save + evaluate
    }

    func stopNow() { config.manualOverride = .forceOff }

    func followSchedule() {
        clearStandDown()
        config.manualOverride = .off
    }

    /// Take the room back after standing down. Separate from "Start now" because standing
    /// down is a decision to leave someone else broadcasting: undoing it means evicting them,
    /// so it should take a deliberate click rather than happening on a timer.
    func reconnectNow() {
        Log.controller.notice("stand-down cleared by user; reconnecting")
        clearStandDown()
        evaluate()
    }

    private func clearStandDown() {
        standDown = nil
        retryTimer?.invalidate()
        retryTimer = nil
        retryAfter = nil
        retryBackoff = 2
    }

    func refreshDevices() {
        devices = DeviceMonitor.inputDevices()
    }

    /// The currently configured device, if connected.
    var selectedDevice: AudioInputDevice? {
        guard let uid = config.deviceUID else { return nil }
        return devices.first { $0.uid == uid }
    }

    // MARK: - Core evaluation

    private func configChanged() {
        store.save(config)
        evaluate()
    }

    /// Decide whether we should be running and reconcile the capture/publish lifecycle.
    private func evaluate() {
        let wantRun = Scheduler.shouldRun(now: Date(),
                                          schedule: config.schedule,
                                          manualOverride: config.manualOverride)
        if !wantRun {
            teardown()
            // A stand-down lasts for the run it happened in, no longer: next Sunday starts
            // clean, without anyone having to remember to clear it.
            clearStandDown()
            status = .idle
            return
        }

        // Evicted or kicked. Coming back would fight whoever holds the room now, so wait for
        // a person — checked before the device and backoff branches, which would otherwise
        // overwrite the one status that explains why nothing is happening.
        if let standDown {
            status = .standby(standDown)
            return
        }

        guard let uid = config.deviceUID, let device = DeviceMonitor.device(forUID: uid) else {
            teardown()
            let name = config.deviceUID ?? "none selected"
            status = .waitingForDevice(name)
            return
        }

        // Honor backoff after a failure before retrying.
        if let retryAfter, Date() < retryAfter { return }

        // Reconcile the pipeline rather than only starting one. The old guard was
        // `capture == nil`, which meant a *half*-alive pipeline — capture still running, room
        // dead — was indistinguishable from a healthy one and wedged here forever. Checking
        // both halves makes this tick self-healing even if a publisher callback is missed
        // entirely (issue #97).
        if !isPipelineRunning {
            teardown()
            startPipeline(device: device)
        }
    }

    /// True only while *both* halves of the capture→publish pipeline are alive. Anything else
    /// has to be torn down and rebuilt — a `Publisher` cannot be restarted in place.
    private var isPipelineRunning: Bool {
        guard capture != nil, let publisher else { return false }
        switch publisher.state {
        case .connecting, .connected, .reconnecting: return true
        case .disconnected, .dropped, .failed: return false
        }
    }

    private func startPipeline(device: AudioInputDevice) {
        let docID = config.resolvedDocID()
        Log.controller.notice("""
            starting pipeline: device \(device.name, privacy: .public) \
            (\(device.inputChannelCount, privacy: .public) ch, uid \(device.uid, privacy: .public)), \
            channel \(self.config.channelIndex + 1, privacy: .public), room \(docID, privacy: .public)
            """)

        let publisher = Publisher(serverURL: config.serverURL)
        publisher.onStateChange = { [weak self] pubState in
            Task { @MainActor in self?.handlePublisherState(pubState) }
        }
        self.publisher = publisher

        let capture = AudioCapture(channelIndex: config.channelIndex)
        capture.onMonoBuffer = { [weak publisher] buffer in
            Task { @MainActor in publisher?.capture(buffer) }
        }
        capture.onLevel = { [weak self] level in
            Task { @MainActor in self?.level = LevelMeter.displayLevel(rms: level) }
        }
        self.capture = capture

        do {
            try capture.start(deviceID: device.id)
            publisher.start(room: docID)
            status = .connecting
        } catch {
            Log.controller.error("capture start failed: \(String(describing: error), privacy: .public)")
            status = .error("\(error)")
            scheduleRetry()
        }
    }

    private func handlePublisherState(_ pubState: Publisher.State) {
        switch pubState {
        case .connecting:
            status = .connecting
        case .connected:
            status = .publishing
            retryTimer?.invalidate()       // reset backoff on success
            retryTimer = nil
            retryBackoff = 2
            retryAfter = nil
        case .reconnecting:
            // The SDK recovers transient drops itself. Surface it rather than keep claiming
            // "Publishing" — no audio is reaching the room while this lasts.
            status = .reconnecting
        case .disconnected:
            // Only `teardown()` produces this, and it already knows what happens next.
            break
        case let .dropped(cause):
            switch DisconnectPolicy.response(to: cause) {
            case .retry:
                Log.controller.error("lost the room: \(cause.description, privacy: .public); reconnecting")
                status = .error("Disconnected: \(cause.description)")
                teardown()
                scheduleRetry()
            case let .standDown(message):
                Log.controller.error("lost the room: \(cause.description, privacy: .public); staying down")
                teardown()
                standDown = message
                status = .standby(message)
            }
        case let .failed(msg):
            status = .error(msg)
            teardown()
            scheduleRetry()
        }
    }

    private func scheduleRetry() {
        retryAfter = Date().addingTimeInterval(retryBackoff)
        Log.controller.notice("retrying in \(self.retryBackoff, privacy: .public)s")

        // The 15s tick would eventually re-evaluate, but it would round every backoff shorter
        // than itself up to 15s. Wake up when the backoff actually expires as well.
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: retryBackoff, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.evaluate() }
        }

        retryBackoff = min(retryBackoff * 2, 30)
    }

    private func teardown() {
        capture?.stop()
        capture = nil
        publisher?.stop()
        publisher = nil
        level = 0
    }
}
