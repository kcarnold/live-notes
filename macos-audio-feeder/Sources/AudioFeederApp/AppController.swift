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
        case error(String)

        var label: String {
            switch self {
            case .idle: return "Idle (off schedule)"
            case let .waitingForDevice(name): return "Waiting for device: \(name)"
            case .connecting: return "Connecting…"
            case .publishing: return "Publishing"
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
    @Published var config: FeederConfig {
        didSet { configChanged() }
    }

    private let store = ConfigStore()
    private let deviceMonitor = DeviceMonitor()
    private var capture: AudioCapture?
    private var publisher: Publisher?

    private var tick: Timer?
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

    func startNow() { config.manualOverride = .forceOn }   // didSet → save + evaluate
    func stopNow() { config.manualOverride = .forceOff }
    func followSchedule() { config.manualOverride = .off }

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
            status = .idle
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

        if capture == nil { startPipeline(device: device) }
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
            retryBackoff = 2               // reset backoff on success
            retryAfter = nil
        case .disconnected:
            if case .publishing = status { status = .idle }
        case let .failed(msg):
            status = .error(msg)
            teardown()
            scheduleRetry()
        }
    }

    private func scheduleRetry() {
        retryAfter = Date().addingTimeInterval(retryBackoff)
        Log.controller.notice("retrying in \(self.retryBackoff, privacy: .public)s")
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
