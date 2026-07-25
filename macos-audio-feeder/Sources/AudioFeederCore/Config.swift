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
}

/// User-editable settings for the feeder. Persisted as JSON.
public struct FeederConfig: Codable, Equatable, Sendable {
    /// Base URL of the live-notes server that issues LiveKit tokens, e.g. `https://notelate.com`.
    public var serverURL: String
    /// Optional explicit Y-Sweet/LiveKit doc id. When nil, defaults to `doc-YYYY-MM-DD` (local).
    public var docIDOverride: String?
    /// CoreAudio device UID of the sound board (stable across hotplug, unlike device index).
    public var deviceUID: String?
    /// 0-based channel index to pull from the multichannel device.
    public var channelIndex: Int
    public var schedule: Schedule
    public var manualOverride: ManualOverride

    public init(serverURL: String = "https://notelate.com",
                docIDOverride: String? = nil,
                deviceUID: String? = nil,
                channelIndex: Int = 0,
                schedule: Schedule = Schedule(),
                manualOverride: ManualOverride = .off) {
        self.serverURL = serverURL
        self.docIDOverride = docIDOverride
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
