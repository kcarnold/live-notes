import Foundation

/// Pure decision logic for whether the feeder should be running right now.
///
/// Kept free of any audio/LiveKit dependencies so it is trivially unit-testable with an
/// injected clock and calendar.
public enum Scheduler {

    /// Whether the feeder should be capturing+publishing at `now`.
    ///
    /// The schedule is the standing answer; a `RunHold` preempts it for one run's worth of time
    /// and then expires on its own (see `RunHold`). Deliberately stateless: given the same
    /// arguments it always returns the same answer, so nothing depends on a timer having fired.
    public static func shouldRun(now: Date,
                                 schedule: Schedule,
                                 hold: RunHold?,
                                 calendar: Calendar = .current) -> Bool {
        if let hold, hold.isLive(at: now) { return hold.publish }
        return schedule.isActive(at: now, calendar: calendar)
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

    /// Next calendar weekday (1 = Sunday ... 7 = Saturday), wrapping Saturday -> Sunday.
    public static func nextWeekday(_ weekday: Int) -> Int {
        weekday == 7 ? 1 : weekday + 1
    }
}

// MARK: - Locating a schedule in real time
//
// Everything above works in (weekday, minuteOfDay); everything here turns that into `Date`s.
// The split matters because the two obey different clocks *on purpose*: the schedule is
// wall-clock ("10:00 means 10:00, DST or not"), while a hold's 4-hour cap is absolute elapsed
// time, because it exists to bound airtime and cost rather than to name a clock reading.
//
// The edge lookups delegate the calendar walk to `Calendar.nextDate(after:matching:)` rather
// than doing day arithmetic here. An earlier draft searched minute by minute for "when does
// the state next flip", which was a hand-rolled reimplementation of exactly that call — and
// the signal that the *edges*, not the states, are what this needs to compute.

extension Schedule {

    /// Whether the schedule (ignoring any hold) has the feeder on at `date`.
    public func isActive(at date: Date, calendar: Calendar = .current) -> Bool {
        guard enabled else { return false }
        let comps = calendar.dateComponents([.weekday, .hour, .minute], from: date)
        guard let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else {
            return false
        }
        return Scheduler.isWithinWindow(weekday: weekday,
                                        minuteOfDay: hour * 60 + minute,
                                        schedule: self)
    }

    /// The next instant the schedule starts a run, strictly after `after`.
    ///
    /// Nil for any schedule that can never run, which is what makes a hold's cap the fallback
    /// for an inert schedule rather than a special case.
    public func nextStart(after: Date, calendar: Calendar = .current) -> Date? {
        guard willEverRun else { return nil }
        return nextEdge(minute: startMinute, days: activeDays, after: after, calendar: calendar)
    }

    /// The next instant the schedule ends a run, strictly after `after`.
    public func nextStop(after: Date, calendar: Calendar = .current) -> Date? {
        guard willEverRun else { return nil }
        // A wrapping run ends the morning *after* its start day — the same anchoring rule
        // `isWithinWindow` uses, and the reason the stop edge can't just reuse `activeDays`.
        let stopDays = startMinute < stopMinute
            ? activeDays
            : Set(activeDays.map(Scheduler.nextWeekday))
        return nextEdge(minute: stopMinute, days: stopDays, after: after, calendar: calendar)
    }

    /// Earliest occurrence of `minute`-of-day on any of `days`, strictly after `after`.
    private func nextEdge(minute: Int, days: Set<Int>, after: Date, calendar: Calendar) -> Date? {
        days.compactMap { weekday in
            // `.nextTime` is what makes the spring-forward gap behave: on a day where the
            // matched wall-clock time doesn't exist, it yields the next time that does,
            // rather than skipping the whole week.
            calendar.nextDate(after: after,
                              matching: DateComponents(hour: minute / 60,
                                                       minute: minute % 60,
                                                       second: 0,
                                                       weekday: weekday),
                              matchingPolicy: .nextTime)
        }.min()
    }
}
