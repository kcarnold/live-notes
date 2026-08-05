import SwiftUI
import AudioFeederCore

/// Settings sheet: server, doc, device + channel, schedule, and login-item registration.
struct ConfigView: View {
    @ObservedObject var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var launchAtLogin = LoginItem.isEnabled

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
                    // The one line that says what the settings above actually add up to,
                    // including the ways a full week of buttons still never runs.
                    Label(controller.config.schedule.summary,
                          systemImage: controller.config.schedule.willEverRun
                              ? "calendar.badge.clock" : "calendar.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(controller.config.schedule.willEverRun ? Color.secondary : Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
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
        VStack(alignment: .leading, spacing: 4) {
            Text("Days the schedule starts on")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                ForEach(1...7, id: \.self) { weekday in
                    WeekdayButton(weekday: weekday,
                                  isOn: controller.config.schedule.days.contains(weekday)) {
                        toggleDay(weekday)
                    }
                }
            }
        }
    }

    private func toggleDay(_ weekday: Int) {
        if controller.config.schedule.days.contains(weekday) {
            controller.config.schedule.days.remove(weekday)
        } else {
            controller.config.schedule.days.insert(weekday)
        }
    }
}

/// One day in the weekday row: a checkbox that happens to be shaped like a chip.
///
/// It draws its own selected/unselected appearance instead of leaning on
/// `.buttonStyle(.bordered).tint(...)`, which was the previous approach and showed **no
/// visible change at all** on some macOS versions — AppKit's bordered push button honours a
/// tint only on newer systems, so on the tech booth Mac every day looked identically
/// unselected and there was no way to tell what you had picked. A filled shape and a
/// checkmark are drawn by us, so they look the same on every system we deploy to.
///
/// Selection is signalled three ways on purpose — fill, checkmark, and weight — because
/// colour alone is exactly what failed, and it is also the thing a colour-blind operator or
/// a washed-out projector-lit screen can't rely on.
private struct WeekdayButton: View {
    /// `Calendar` weekday: 1 = Sunday ... 7 = Saturday.
    let weekday: Int
    let isOn: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            VStack(spacing: 1) {
                Text(Schedule.weekdaySymbol(weekday))
                    .font(.caption.weight(isOn ? .semibold : .regular))
                Image(systemName: isOn ? "checkmark" : "minus")
                    .font(.system(size: 8, weight: .bold))
                    .opacity(isOn ? 1 : 0.45)
            }
            .foregroundStyle(isOn ? Color.white : Color.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(isOn ? Color.accentColor : Color.secondary.opacity(0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(isOn ? Color.accentColor : Color.secondary.opacity(0.45),
                                  lineWidth: 1)
            )
            // The whole chip is the hit target, not just the glyphs inside it.
            .contentShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .help(helpText)
        .accessibilityLabel(name)
        .accessibilityValue(stateText)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }

    // Spelled out as `String`s rather than inline ternaries so the `help`/`accessibility*`
    // overloads have one obvious argument type to resolve against.
    private var name: String { Schedule.weekdayName(weekday) }

    private var stateText: String { isOn ? "Scheduled" : "Skipped" }

    private var helpText: String {
        isOn ? "\(name): the schedule starts the feeder this day. Click to skip it."
             : "\(name): the schedule skips this day. Click to run it."
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
