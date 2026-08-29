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
        case idle                    // not supposed to be running right now
        case waitingForDevice(String)
        case resolvingSession        // asking the server which doc we are in (#111)
        case connecting
        case publishing
        case reconnecting            // was publishing; the room dropped and we're coming back
        case standby(String)         // stopped on purpose and *not* retrying — see standDown
        case error(String)

        var label: String {
            switch self {
            // Not "Idle (off schedule)": with a hold in play the schedule isn't always the
            // reason, and the sentence underneath this line says which reason it is.
            case .idle: return "Idle"
            case let .waitingForDevice(name): return "Waiting for device: \(name)"
            case .resolvingSession: return "Finding the current session…"
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

    /// A manual start/stop that outranks the schedule until the schedule's next edge. In memory
    /// only — see `FeederConfig.schedule`.
    @Published private(set) var hold: RunHold?

    @Published var config: FeederConfig {
        didSet { configChanged(from: oldValue) }
    }

    private let store = ConfigStore()
    private let deviceMonitor = DeviceMonitor()
    private var capture: AudioCapture?
    private var publisher: Publisher?

    /// What the server has told us about which doc we are in, and how long that may be acted
    /// on. Never computed here — see `SessionClient` for why there is no local date formula,
    /// and `SessionResolution` for the expiry rules. Published because the settings window
    /// reports the answer rather than predicting one.
    @Published private(set) var session = SessionResolution()
    private var sessionResolve: Task<Void, Never>?

    private var tick: Timer?
    private var retryTimer: Timer?
    private var retryAfter: Date?
    private var retryBackoff: TimeInterval = 2
    private var evaluatePending = false

    init() {
        self.config = store.load()
        refreshDevices()

        Log.controller.notice("""
            launched; server \(self.config.serverURL, privacy: .public), \
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

    // MARK: - Manual holds (UI buttons)
    //
    // All three go through `scheduleEvaluate()` rather than `evaluate()` directly: these run
    // from SwiftUI button actions, and `evaluate()` mutates `@Published` state. See the comment
    // on `scheduleEvaluate` for what that combination does inside a view update.

    func startNow() {
        clearStandDown()
        setHold(.starting(true, at: Date(), schedule: config.schedule))
    }

    func stopNow() { setHold(.starting(false, at: Date(), schedule: config.schedule)) }

    /// Drop the hold and let the schedule decide again, immediately.
    func followSchedule() {
        guard hold != nil else { return }
        Log.controller.notice("hold cleared by user")
        hold = nil
        scheduleEvaluate()
    }

    private func setHold(_ newHold: RunHold) {
        hold = newHold
        Log.controller.notice("""
            hold: \(newHold.publish ? "on" : "off", privacy: .public) until \
            \(newHold.endsAt.description(with: .current), privacy: .public)\
            \(newHold.capped ? " (4h cap)" : "", privacy: .public)
            """)
        scheduleEvaluate()
    }

    /// The current decision and the sentence explaining it — everything the popover renders.
    var runPlan: RunPlan {
        RunPlan.evaluate(now: Date(), schedule: config.schedule, hold: hold)
    }

    /// Whether we should be on air right now. The popover's primary button pivots on this
    /// rather than on `isPublishing`, so a stood-down feeder still offers "Stop now" and the
    /// separate `Reconnect` button stays the only way back into a contested room.
    var wantRun: Bool {
        Scheduler.shouldRun(now: Date(), schedule: config.schedule, hold: hold)
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

    /// What the settings window says about the room, in place of the room name it used to
    /// compute. Three honest states: an override, an answer we were given, or not yet asked.
    var sessionSummary: String {
        if let override = SessionClient.normalizedOverride(config.docIDOverride) {
            return "Will publish to room: \(override) — this override outranks the server."
        }
        if let docID = session.docID {
            return "Publishing to room: \(docID) — the server's current session."
        }
        return "The room is whatever session the server says is current when a run starts."
    }

    /// The currently configured device, if connected.
    var selectedDevice: AudioInputDevice? {
        guard let uid = config.deviceUID else { return nil }
        return devices.first { $0.uid == uid }
    }

    // MARK: - Core evaluation

    private func configChanged(from old: FeederConfig) {
        // Re-anchor a live hold to the edited schedule, so "stop now" keeps meaning *end this
        // run* after the run's definition changes. Anchored to the hold's own `setAt`, so this
        // can never stretch it past four hours from the button press. See `RunHold.recomputed`.
        if config.schedule != old.schedule, let hold {
            self.hold = hold.recomputed(for: config.schedule)
        }
        // The answer we hold came from a particular server, under a particular override.
        // Change either and it is no longer an answer to the question we are now asking.
        if config.serverURL != old.serverURL || config.docIDOverride != old.docIDOverride {
            forgetSession()
        }
        store.save(config)
        scheduleEvaluate()
    }

    /// Re-evaluate on the next runloop turn rather than inside this `didSet`.
    ///
    /// `config` is `@Published` and every settings control writes it through a `Binding`, so
    /// this `didSet` can run **inside SwiftUI's view-update pass** — and `evaluate()` mutates
    /// other `@Published` state (`status`, `devices`, `standDown`). That combination is what
    /// "Publishing changes from within view updates is not allowed, this will cause undefined
    /// behavior" is complaining about. A segmented `Picker` is what finally tripped it (it
    /// writes its selection during the update pass, where a `Button` action closure would
    /// not), but the defect was latent for every text field, toggle and stepper in the
    /// settings window.
    ///
    /// Hopping to the next turn also coalesces bursts: every keystroke in the settings window
    /// is a config mutation, and `evaluate()` does a full synchronous CoreAudio device
    /// enumeration.
    private func scheduleEvaluate() {
        guard !evaluatePending else { return }
        evaluatePending = true
        Task { @MainActor in
            evaluatePending = false
            evaluate()
        }
    }

    /// Decide whether we should be running and reconcile the capture/publish lifecycle.
    private func evaluate() {
        let now = Date()
        // Retire an expired hold so the UI stops describing one that no longer decides
        // anything. `shouldRun` ignores it either way — this is bookkeeping, not the decision.
        if let hold, !hold.isLive(at: now) {
            Log.controller.notice("hold expired; following the schedule")
            self.hold = nil
        }

        let wantRun = Scheduler.shouldRun(now: now, schedule: config.schedule, hold: hold)
        if !wantRun {
            teardown()
            // A stand-down lasts for the run it happened in, no longer: next Sunday starts
            // clean, without anyone having to remember to clear it.
            clearStandDown()
            // Same for the doc. The answer expires on its own (`SessionResolution`), so
            // this is belt-and-braces — but it is what makes the *log* honest: every run
            // that starts prints the session it was given, rather than silently inheriting.
            forgetSession()
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

        // Which doc? The server owns that answer and this app does not guess at it, so
        // nothing starts until it has said. Failures are handled in `sessionResolutionFailed`.
        let fresh = session.isFresh(at: now)
        if !fresh { resolveSession() }
        // A live pipeline keeps publishing into the room it is in while a re-ask is in
        // flight — the doc question can wait a minute, the broadcast cannot. Nothing *starts*
        // on an answer that has aged out, which is what stops a Mac that slept through the
        // gap between two Sunday windows from opening the mic in last week's doc.
        guard let docID = session.docID, fresh || isPipelineRunning else { return }

        // A live pipeline publishing into a room that is no longer the current session is
        // the failure this whole path exists to prevent: the microphone left behind in the
        // doc an operator just moved everyone off. Reconciled here rather than torn down at
        // the point the answer changes, so it is caught however the two came to differ.
        if isPipelineRunning, publisher?.docID != docID {
            Log.controller.notice("""
                publishing into \(self.publisher?.docID ?? "-", privacy: .public) but the session \
                is \(docID, privacy: .public); rebuilding the pipeline
                """)
            teardown()
        }

        // Reconcile the pipeline rather than only starting one. The old guard was
        // `capture == nil`, which meant a *half*-alive pipeline — capture still running, room
        // dead — was indistinguishable from a healthy one and wedged here forever. Checking
        // both halves makes this tick self-healing even if a publisher callback is missed
        // entirely (issue #97).
        if !isPipelineRunning {
            teardown()
            startPipeline(device: device, docID: docID)
        }
    }

    // MARK: - The current session (#111)

    /// Ask the server which doc we are in.
    ///
    /// Whether this is blocking is not a property of the call — it is whether anything is on
    /// air right now, which both ends read off the pipeline. A re-ask behind a live broadcast
    /// must not touch `status`: painting "Finding the current session…" (or an error) over a
    /// healthy pipeline is #97's defect again, the menu bar describing a state the feeder is
    /// not in, and nothing on the success path would repaint it afterwards.
    private func resolveSession() {
        guard sessionResolve == nil else { return }
        if !isPipelineRunning { status = .resolvingSession }

        let client = SessionClient(serverURL: config.serverURL)
        let override = config.docIDOverride
        sessionResolve = Task { @MainActor [weak self] in
            do {
                let resolved = try await client.resolve(override: override)
                // Cancelled means `forgetSession` already moved on — and has already cleared
                // this reference, possibly in favour of a newer task.
                guard !Task.isCancelled, let self else { return }
                self.sessionResolve = nil
                self.sessionResolved(resolved)
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.sessionResolve = nil
                self.sessionResolutionFailed(error)
            }
        }
    }

    private func sessionResolved(_ resolved: ResolvedSession) {
        let previous = session.docID
        let moved = session.record(docID: resolved.docID, at: Date())
        if moved {
            // The pin reached us mid-run. `evaluate` does the rebuilding — a `Publisher`
            // cannot be retargeted in place any more than it can be restarted.
            Log.controller.notice("""
                session moved: \(previous ?? "-", privacy: .public) -> \(resolved.docID, privacy: .public) \
                (\(resolved.origin, privacy: .public))
                """)
        } else if previous == nil {
            Log.controller.notice(
                "session: \(resolved.docID, privacy: .public) (\(resolved.origin, privacy: .public))")
        }
        // Unconditionally, including when the answer came back unchanged: confirming a stale
        // answer is what makes it usable again, and a run may be waiting on exactly that.
        scheduleEvaluate()
    }

    private func sessionResolutionFailed(_ error: Error) {
        let detail = String(describing: error)
        guard !isPipelineRunning else {
            // Failing behind a working pipeline is not a reason to drop it: a stale doc
            // answer costs a minute, dropping the pipeline costs the broadcast. Keep the
            // answer, and ask again after the usual interval rather than every tick.
            Log.controller.error("""
                session re-check failed: \(detail, privacy: .public); \
                staying on \(self.session.docID ?? "-", privacy: .public)
                """)
            session.extendFreshness(from: Date())
            return
        }
        // Nothing to fall back to, and deliberately so: the same server issues the LiveKit
        // token, so a server we can't reach means a run that couldn't have started anyway.
        // Say which failure it is instead of publishing into a doc nobody chose.
        Log.controller.error("cannot resolve the current session: \(detail, privacy: .public)")
        status = .error("Can't reach \(config.serverURL): \(detail)")
        scheduleRetry()
    }

    private func forgetSession() {
        sessionResolve?.cancel()
        sessionResolve = nil
        session.forget()
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

    private func startPipeline(device: AudioInputDevice, docID: String) {
        Log.controller.notice("""
            starting pipeline: device \(device.name, privacy: .public) \
            (\(device.inputChannelCount, privacy: .public) ch, uid \(device.uid, privacy: .public)), \
            channel \(self.config.channelIndex + 1, privacy: .public), room \(docID, privacy: .public)
            """)

        let publisher = Publisher(serverURL: config.serverURL, writeKey: config.writeKey)
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
