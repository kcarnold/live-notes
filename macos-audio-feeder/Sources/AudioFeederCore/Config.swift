import Foundation

/// Whether the user has forced the feeder on/off regardless of the schedule.
public enum ManualOverride: String, Codable, Sendable, CaseIterable {
    /// Follow the schedule.
    case off
    /// Run now, ignore the schedule.
    case forceOn
    /// Stay off now, ignore the schedule.
    case forceOff
}

/// A daily run window plus the weekdays it applies to.
///
/// Minutes are minutes-since-local-midnight in `[0, 1440)`. If `stopMinute` is greater
/// than `startMinute` the window is same-day `[start, stop)`; if it is less, the window
/// wraps past midnight (anchored to the start day); if equal, the window is empty.
public struct Schedule: Codable, Equatable, Sendable {
    public var enabled: Bool
    /// Calendar weekdays the window starts on: 1 = Sunday ... 7 = Saturday (matches `Calendar`).
    public var days: Set<Int>
    public var startMinute: Int
    public var stopMinute: Int

    public init(enabled: Bool = false,
                days: Set<Int> = [1, 2, 3, 4, 5, 6, 7],
                startMinute: Int = 10 * 60,
                stopMinute: Int = 12 * 60) {
        self.enabled = enabled
        self.days = days
        self.startMinute = startMinute
        self.stopMinute = stopMinute
    }

    /// `"HH:mm"` for a minutes-since-midnight value, clamped to a valid range.
    public static func formatHHMM(_ minute: Int) -> String {
        let m = max(0, min(24 * 60 - 1, minute))
        return String(format: "%02d:%02d", m / 60, m % 60)
    }

    /// Parse `"HH:mm"` into minutes since midnight, or nil if malformed/out of range.
    public static func parseHHMM(_ text: String) -> Int? {
        let parts = text.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0..<24).contains(h), (0..<60).contains(m) else { return nil }
        return h * 60 + m
    }

    // MARK: - Describing the schedule in words
    //
    // The settings window can't rely on a highlight alone to say when the feeder will run:
    // a tinted button is invisible on some macOS versions, ambiguous on the rest, and says
    // nothing at all about the cases where a fully-selected week still never starts (schedule
    // off, empty window). So the UI also states the outcome in words, and the sentence is
    // built here — pure, and covered by `swift test` with no Xcode and no UI.
    //
    // English-only on purpose: the app is a single-operator utility with a hard-coded English
    // UI throughout, and localized weekday symbols would reorder against the fixed Sun-first
    // button row.

    /// Three-letter weekday labels, indexed by `Calendar` weekday (1 = Sunday ... 7 = Saturday).
    public static let weekdaySymbols = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    /// Full weekday names, indexed by `Calendar` weekday (1 = Sunday ... 7 = Saturday).
    public static let weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday",
                                      "Thursday", "Friday", "Saturday"]

    /// `"Sun"` for weekday 1 ... `"Sat"` for weekday 7; `"?"` for anything out of range.
    public static func weekdaySymbol(_ weekday: Int) -> String {
        (1...7).contains(weekday) ? weekdaySymbols[weekday - 1] : "?"
    }

    /// `"Sunday"` for weekday 1 ... `"Saturday"` for weekday 7; `"?"` for anything out of range.
    public static func weekdayName(_ weekday: Int) -> String {
        (1...7).contains(weekday) ? weekdayNames[weekday - 1] : "?"
    }

    /// The selected days, ignoring anything outside `1...7`.
    public var activeDays: Set<Int> {
        days.filter { (1...7).contains($0) }
    }

    /// Whether this schedule can ever start the feeder on its own. False for all three inert
    /// shapes: switched off, no days picked, or a zero-length window.
    public var willEverRun: Bool {
        enabled && !activeDays.isEmpty && startMinute != stopMinute
    }

    /// The selected days as a phrase: `"every day"`, `"weekdays"`, `"weekends"`,
    /// `"Sun, Wed"`, or `"no days"`. Always in Sunday-first calendar order.
    public var daysDescription: String {
        let selected = activeDays
        if selected.isEmpty { return "no days" }
        if selected.count == 7 { return "every day" }
        if selected == [2, 3, 4, 5, 6] { return "weekdays" }
        if selected == [1, 7] { return "weekends" }
        return selected.sorted().map(Schedule.weekdaySymbol).joined(separator: ", ")
    }

    /// One sentence stating whether — and when — the schedule will start the feeder.
    ///
    /// Names every way a schedule can be inert, because each of them looks identical in the
    /// day-button row: turned off, no days picked, or a zero-length window.
    public var summary: String {
        guard enabled else {
            return "Schedule off — the feeder runs only when you press Start now."
        }
        if activeDays.isEmpty {
            return "No days selected — the schedule will never start the feeder."
        }
        if startMinute == stopMinute {
            return "Start and stop are the same time — the schedule will never start the feeder."
        }
        let window = "\(Schedule.formatHHMM(startMinute))–\(Schedule.formatHHMM(stopMinute))"
        // A wrapping window is anchored to its start day (see `Scheduler.isWithinWindow`), so
        // the selected days are start days, and the run finishes on the following morning.
        let tail = startMinute < stopMinute ? "" : " the next day"
        return "Runs \(daysDescription), \(window)\(tail)."
    }
}

/// User-editable settings for the feeder. Persisted as JSON.
public struct FeederConfig: Codable, Equatable, Sendable {
    /// Base URL of the live-notes server that issues LiveKit tokens, e.g. `https://notelate.com`.
    public var serverURL: String
    /// Optional explicit Y-Sweet/LiveKit doc id. When nil, defaults to `doc-YYYY-MM-DD` (local).
    public var docIDOverride: String?
    /// Shared key authorizing this machine to take the microphone (server side: writeAuth.ts).
    /// Publishing evicts whoever is currently broadcasting, so the server gates it on a key.
    /// Optional: while the server runs in observe mode a keyless request is still served.
    ///
    /// Persisted in the same plaintext JSON as the rest of the config, not the Keychain —
    /// adequate for a key that only grants the room's microphone, and rotated by editing
    /// the server's WRITE_KEYS.
    public var writeKey: String?
    /// CoreAudio device UID of the sound board (stable across hotplug, unlike device index).
    public var deviceUID: String?
    /// 0-based channel index to pull from the multichannel device.
    public var channelIndex: Int
    public var schedule: Schedule
    public var manualOverride: ManualOverride

    public init(serverURL: String = "https://notelate.com",
                docIDOverride: String? = nil,
                writeKey: String? = nil,
                deviceUID: String? = nil,
                channelIndex: Int = 0,
                schedule: Schedule = Schedule(),
                manualOverride: ManualOverride = .off) {
        self.serverURL = serverURL
        self.docIDOverride = docIDOverride
        self.writeKey = writeKey
        self.deviceUID = deviceUID
        self.channelIndex = channelIndex
        self.schedule = schedule
        self.manualOverride = manualOverride
    }

    /// The effective doc id / LiveKit room name for `now`, honoring an override.
    public func resolvedDocID(now: Date = Date(), calendar: Calendar = .current) -> String {
        if let override = docIDOverride, !override.trimmingCharacters(in: .whitespaces).isEmpty {
            return override
        }
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "doc-%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
