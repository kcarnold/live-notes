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

            // Manual override controls (your "manual + scheduled" choice).
            HStack {
                Button("Start now") { controller.startNow() }
                    .disabled(controller.config.manualOverride == .forceOn)
                Button("Stop now") { controller.stopNow() }
                    .disabled(controller.config.manualOverride == .forceOff)
                if controller.config.manualOverride != .off {
                    Button("Follow schedule") { controller.followSchedule() }
                }
            }
            .font(.callout)

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

    private var statusColor: Color {
        switch controller.status {
        case .publishing: return .green
        case .connecting: return .yellow
        case .waitingForDevice: return .orange
        case .error: return .red
        case .idle: return .gray
        }
    }
}
