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

            modePicker
            modeSummary

            // A stand-down waits for a person, so it needs a person-shaped way out. "Start
            // now" can't serve: it's disabled whenever the override is already .forceOn,
            // which is exactly the state an always-on install stands down from.
            // The status line above already says *why* we're stopped; this says what the
            // button does, because it isn't harmless.
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

    /// What decides whether the feeder runs — as a control whose selection *is* the state.
    ///
    /// This replaced three buttons ("Start now" / "Stop now" / "Follow schedule", the last
    /// appearing only while an override was active). Two problems with that: the mode was
    /// never on screen, only inferable from which button was disabled; and "Follow schedule"
    /// read as a *sibling* of Settings' "Enable schedule" checkbox, when it is actually the
    /// outer switch — it decides whether the schedule is consulted at all, and changes
    /// nothing about the schedule itself. Segments make the mode visible, and make it clear
    /// there are exactly three ways this can go.
    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("When to publish").font(.caption).foregroundStyle(.secondary)
            Picker("When to publish", selection: modeBinding) {
                Text("Schedule").tag(ManualOverride.off)
                Text("Always on").tag(ManualOverride.forceOn)
                Text("Always off").tag(ManualOverride.forceOff)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    /// Routes through the controller's existing methods rather than writing `manualOverride`
    /// directly: `startNow()` and `followSchedule()` also clear a stand-down, and skipping
    /// that would leave the feeder standing down in a mode that says it shouldn't be.
    ///
    /// The hop off the current runloop turn is required, not stylistic. SwiftUI writes a
    /// `Picker`'s selection through this binding **during its view-update pass**, and all
    /// three of these methods mutate `@Published` state on the controller (`standDown` here,
    /// `config` → `status` downstream) — which is "Publishing changes from within view
    /// updates is not allowed". A `Button`'s action closure runs outside that pass, which is
    /// why the three buttons this replaced never tripped it.
    private var modeBinding: Binding<ManualOverride> {
        Binding(
            get: { controller.config.manualOverride },
            set: { mode in
                Task { @MainActor in
                    switch mode {
                    case .off: controller.followSchedule()
                    case .forceOn: controller.startNow()
                    case .forceOff: controller.stopNow()
                    }
                }
            })
    }

    /// What the selected mode will actually do — including the cases where it will do nothing.
    ///
    /// The popover said what the feeder was doing *now* ("Idle") but never whether anything
    /// would change that. An install in Schedule mode with the schedule switched off sits at
    /// "Idle" indefinitely and looks exactly like one that is five minutes from going live.
    private var modeSummary: some View {
        HStack(spacing: 6) {
            Image(systemName: controller.config.willStartUnattended
                  ? "calendar" : "calendar.badge.exclamationmark")
            Text(controller.config.modeSummary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        // Orange only when nothing will start the feeder on its own. "Always off" earns it
        // too: it is a deliberate choice, but it is also the one an unattended install can
        // be left in by accident after a service.
        .foregroundStyle(controller.config.willStartUnattended ? Color.secondary : Color.orange)
        .help(controller.config.modeSummary)
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
