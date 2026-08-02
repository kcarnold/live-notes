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
                    SecureField("Write key (must match the server)",
                                text: Binding(
                                    get: { controller.config.writeKey ?? "" },
                                    set: { controller.config.writeKey = $0.isEmpty ? nil : $0 }))
                    Text("Required to take the microphone.")
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
                    MinuteField(label: "Start", minute: $controller.config.schedule.startMinute)
                    MinuteField(label: "Stop", minute: $controller.config.schedule.stopMinute)
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

}

/// An `HH:mm` text field over a minutes-since-midnight value.
///
/// It needs its own `@State` string rather than a computed `Binding` over the `Int`, because
/// a get/set binding that only writes back on a successful parse makes the field unusable:
/// every intermediate keystroke ("0", "09", "09:") is invalid, so the setter no-ops, SwiftUI
/// re-renders the *old* formatted value, and the character the user just typed vanishes. The
/// field looks frozen when it is actually reverting you 60 times a second.
///
/// So: the local text is authoritative while the field has focus, the model is updated
/// whenever the text happens to parse, and on blur or Return the text is normalized back to
/// `HH:mm` (reverting to the last good value if what's there is unparseable).
private struct MinuteField: View {
    let label: String
    @Binding var minute: Int

    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            TextField("HH:mm", text: $text)
                .frame(width: 70)
                .multilineTextAlignment(.trailing)
                .focused($focused)
                .onSubmit { commit() }
                .onChange(of: text) { _, new in
                    // Track the model live while it's parseable, but never rewrite `text`.
                    if let m = Schedule.parseHHMM(new) { minute = m }
                }
                .onChange(of: focused) { _, isFocused in
                    if !isFocused { commit() }
                }
                .onChange(of: minute) { _, new in
                    // Outside edits (e.g. loading config) win only when we're not typing.
                    if !focused { text = Schedule.formatHHMM(new) }
                }
                .onAppear { text = Schedule.formatHHMM(minute) }
        }
    }

    private func commit() {
        if let m = Schedule.parseHHMM(text) { minute = m }
        text = Schedule.formatHHMM(minute)
    }
}
