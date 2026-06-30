import SwiftUI
import AudioFeederCore

/// Settings sheet: server, doc, device + channel, schedule, and login-item registration.
struct ConfigView: View {
    @ObservedObject var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var launchAtLogin = LoginItem.isEnabled

    private let weekdaySymbols = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] // index 0 => weekday 1

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Audio Feeder Settings").font(.headline).padding()
            Divider()
            Form {
                Section("Server") {
                    TextField("Server URL", text: $controller.config.serverURL)
                    TextField("Doc id (blank = today's doc-YYYY-MM-DD)",
                              text: Binding(
                                get: { controller.config.docIDOverride ?? "" },
                                set: { controller.config.docIDOverride = $0.isEmpty ? nil : $0 }))
                    Text("Will publish to room: \(controller.config.resolvedDocID())")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Input") {
                    Picker("Device", selection: Binding(
                        get: { controller.config.deviceUID ?? "" },
                        set: { controller.config.deviceUID = $0.isEmpty ? nil : $0 })) {
                        Text("None").tag("")
                        ForEach(controller.devices) { dev in
                            Text("\(dev.name) (\(dev.inputChannelCount) ch)").tag(dev.uid)
                        }
                    }
                    Button("Refresh devices") { controller.refreshDevices() }

                    Stepper(value: $controller.config.channelIndex,
                            in: 0...maxChannel) {
                        Text("Channel: \(controller.config.channelIndex + 1)\(channelSuffix)")
                    }
                }

                Section("Schedule") {
                    Toggle("Enable schedule", isOn: $controller.config.schedule.enabled)
                    weekdayPicker
                    timeField("Start", minute: $controller.config.schedule.startMinute)
                    timeField("Stop", minute: $controller.config.schedule.stopMinute)
                    Text("Manual override always wins over the schedule.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Service") {
                    Toggle("Launch at login (run as a service)", isOn: $launchAtLogin)
                        .onChange(of: launchAtLogin) { _, newValue in
                            LoginItem.setEnabled(newValue)
                        }
                    Text("Audio capture needs a logged-in session; on an auto-login Mac this runs unattended.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding()
        }
        .frame(width: 420, height: 560)
    }

    private var maxChannel: Int {
        max(0, (controller.selectedDevice?.inputChannelCount ?? 32) - 1)
    }

    private var channelSuffix: String {
        if let dev = controller.selectedDevice { return " of \(dev.inputChannelCount)" }
        return ""
    }

    private var weekdayPicker: some View {
        HStack(spacing: 4) {
            ForEach(0..<7, id: \.self) { idx in
                let weekday = idx + 1
                let on = controller.config.schedule.days.contains(weekday)
                Button(weekdaySymbols[idx]) {
                    if on { controller.config.schedule.days.remove(weekday) }
                    else { controller.config.schedule.days.insert(weekday) }
                }
                .buttonStyle(.bordered)
                .tint(on ? .accentColor : .gray)
                .font(.caption)
            }
        }
    }

    private func timeField(_ label: String, minute: Binding<Int>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("HH:mm", text: Binding(
                get: { Schedule.formatHHMM(minute.wrappedValue) },
                set: { if let m = Schedule.parseHHMM($0) { minute.wrappedValue = m } }))
                .frame(width: 70)
                .multilineTextAlignment(.trailing)
        }
    }
}
