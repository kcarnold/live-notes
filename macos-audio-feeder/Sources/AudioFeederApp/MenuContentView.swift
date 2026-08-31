import SwiftUI
import AudioFeederCore

/// The menu-bar popover: status, level meter, manual controls, and a way into settings.
struct MenuContentView: View {
    @ObservedObject var controller: AppController
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Audio Feeder").font(.headline)
                Spacer()
                Circle()
                    .fill(statusColor)
                    .frame(width: 10, height: 10)
            }

            // Error labels carry a whole LiveKit error description, so cap the line count:
            // an unbounded wrap here is what made the popover lurch between sizes. The full
            // text is in the log (`category == "publisher"`) and in the tooltip.
            Text(controller.status.label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(3)
                .help(controller.status.label)

            VStack(alignment: .leading, spacing: 4) {
                Text("Input level").font(.caption).foregroundStyle(.secondary)
                LevelMeterView(level: controller.level, active: controller.isPublishing)
            }

            deviceSummary

            Divider()

            runControls
            planSummary

            // A stand-down waits for a person, so it needs a person-shaped way out. The primary
            // button can't serve: while standing down we still *want* to run, so it reads "Stop
            // now" — the opposite of what's needed. The status line above already says *why*
            // we're stopped; this says what the button does, because it isn't harmless.
            if controller.standDown != nil {
                HStack(spacing: 8) {
                    Text("Takes the room back from whoever has it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Reconnect") { controller.reconnectNow() }
                        .font(.callout)
                }
            }

            if controller.isPublishing {
                Label("Live as organizer-host — this takes over the broadcast.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            Divider()

            HStack {
                // Open the standard Settings scene (a real window) and pull it to the front —
                // an .accessory app won't raise its own windows automatically.
                Button("Settings…") {
                    openSettings()
                    NSApp.activate(ignoringOtherApps: true)
                }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
        }
        .padding(14)
        // A fixed width keeps the popover from resizing horizontally as the status text
        // changes; `sizingOptions` in AppDelegate lets the height follow the content.
        .frame(width: 300)
    }

    private var deviceSummary: some View {
        HStack(spacing: 6) {
            Image(systemName: "rectangle.connected.to.line.below")
            if let dev = controller.selectedDevice {
                Text("\(dev.name) · ch \(controller.config.channelIndex + 1)/\(dev.inputChannelCount)")
                    .lineLimit(1)
            } else if let uid = controller.config.deviceUID {
                Text("\(uid) (not connected)").foregroundStyle(.orange).lineLimit(1)
            } else {
                Text("No device selected").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }

    /// Start or stop *this run* — never a mode.
    ///
    /// This replaced a segmented `Schedule | Always on | Always off` picker, which replaced
    /// three buttons before that. The picker's defect wasn't visibility (it fixed that); it was
    /// offering permanent answers to a temporary question. What an operator wants at the sound
    /// board is to start a few minutes early or end a service early — and both of those, in the
    /// old model, meant switching the schedule off entirely and remembering to switch it back.
    /// Nobody remembers, so an install ends up parked on *Always off* through the next Sunday.
    ///
    /// So there is no mode any more: one button that acts on the current run, and a way to take
    /// it back. The state that used to live in the picker is now the sentence below, which says
    /// what happens next and when — a strictly more useful thing to show in the same space.
    private var runControls: some View {
        HStack {
            // Pivots on the decision, not on `isPublishing`: while connecting, reconnecting or
            // standing down we still *want* to run, and offering "Start now" there would be a
            // no-op button on a feeder that is already trying.
            Button(controller.wantRun ? "Stop now" : "Start now") {
                // The hop off the current runloop turn is belt-and-braces here — a `Button`
                // action already runs outside SwiftUI's update pass, unlike the `Picker`
                // binding this replaced (see `AppController.scheduleEvaluate`).
                Task { @MainActor in
                    if controller.wantRun { controller.stopNow() } else { controller.startNow() }
                }
            }
            Spacer()
            // Only meaningful while a hold is in play; the rest of the time the schedule is
            // already what's being followed, and a button saying so would be a no-op.
            if controller.hold != nil {
                Button("Follow schedule") {
                    Task { @MainActor in controller.followSchedule() }
                }
                .font(.callout)
            }
        }
    }

    /// What happens next, and when.
    ///
    /// The popover said what the feeder was doing *now* ("Idle") but never whether anything
    /// would change that. An install whose schedule is switched off sits at "Idle" indefinitely
    /// and looks exactly like one that is five minutes from going live. The sentence is built in
    /// `RunPlan` — pure, and pinned by `swift test` rather than by looking at this window.
    private var planSummary: some View {
        let plan = controller.runPlan
        return HStack(spacing: 6) {
            Image(systemName: plan.warns ? "calendar.badge.exclamationmark" : "calendar")
            Text(plan.summary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        // Orange only when nothing will start the feeder on its own — the state an unattended
        // install can be left in by accident, and the one nothing resolves on its own.
        .foregroundStyle(plan.warns ? Color.orange : Color.secondary)
        // The line names the next event; the tooltip carries the whole schedule, which it no
        // longer repeats.
        .help(controller.config.schedule.summary)
    }

    private var statusColor: Color {
        switch controller.status {
        case .publishing: return .green
        case .connecting, .reconnecting: return .yellow
        // Standing down is deliberate, not broken — but it is the one state nothing will
        // resolve on its own, so it gets a colour that asks to be looked at.
        case .waitingForDevice, .standby: return .orange
        case .error: return .red
        case .idle: return .gray
        }
    }
}
