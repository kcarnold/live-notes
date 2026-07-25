import Foundation

/// Pure decision logic for whether the feeder should be running right now.
///
/// Kept free of any audio/LiveKit dependencies so it is trivially unit-testable with an
/// injected clock and calendar.
public enum Scheduler {

    /// Whether the feeder should be capturing+publishing at `now`.
    ///
    /// Manual override wins; otherwise we fall back to the schedule (disabled => off).
    public static func shouldRun(now: Date,
                                 schedule: Schedule,
                                 manualOverride: ManualOverride,
                                 calendar: Calendar = .current) -> Bool {
        switch manualOverride {
        case .forceOn:
            return true
        case .forceOff:
            return false
        case .off:
            guard schedule.enabled else { return false }
            let comps = calendar.dateComponents([.weekday, .hour, .minute], from: now)
            guard let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else {
                return false
            }
            return isWithinWindow(weekday: weekday, minuteOfDay: hour * 60 + minute, schedule: schedule)
        }
    }

    /// Whether `(weekday, minuteOfDay)` falls inside the schedule's window. Handles
    /// same-day and past-midnight (wrapping) windows; an empty window (start == stop)
    /// is never active.
    public static func isWithinWindow(weekday: Int, minuteOfDay: Int, schedule: Schedule) -> Bool {
        let start = schedule.startMinute
        let stop = schedule.stopMinute
        if start == stop { return false }

        if start < stop {
            // Same-day window [start, stop).
            return schedule.days.contains(weekday) && minuteOfDay >= start && minuteOfDay < stop
        } else {
            // Window wraps past midnight; the run is anchored to its start day.
            if schedule.days.contains(weekday) && minuteOfDay >= start {
                return true
            }
            // Early-morning tail belongs to the previous day's window.
            if schedule.days.contains(previousWeekday(weekday)) && minuteOfDay < stop {
                return true
            }
            return false
        }
    }

    /// Previous calendar weekday (1 = Sunday ... 7 = Saturday), wrapping Sunday -> Saturday.
    public static func previousWeekday(_ weekday: Int) -> Int {
        weekday == 1 ? 7 : weekday - 1
    }
}
