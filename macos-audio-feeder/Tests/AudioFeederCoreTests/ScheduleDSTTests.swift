import XCTest
@testable import AudioFeederCore

/// Daylight saving, in a real zone rather than the UTC calendar the rest of the suite uses.
///
/// The design deliberately mixes two clocks, and this is the only place that can prove it:
///
/// - **The schedule is wall-clock.** "10:00" means whatever the wall says, so the interval
///   between consecutive scheduled starts is 23 or 25 hours across a transition, not 24.
/// - **A hold's cap is absolute elapsed time.** It exists to bound airtime and cost, not to
///   name a clock reading, so four hours is four hours even when the clocks move under it.
///
/// The app runs in America/Detroit; New_York is the canonical zone with identical rules.
/// US transitions in 2026: spring forward Sun 2026-03-08 02:00→03:00, fall back Sun
/// 2026-11-01 02:00→01:00.
final class ScheduleDSTTests: XCTestCase {

    private var eastern: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }

    private func local(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        var c = DateComponents()
        c.year = year; c.month = month; c.day = day; c.hour = hour; c.minute = minute
        return eastern.date(from: c)!
    }

    private func wallClock(_ date: Date) -> String {
        let c = eastern.dateComponents([.month, .day, .hour, .minute], from: date)
        return String(format: "%02d-%02d %02d:%02d", c.month!, c.day!, c.hour!, c.minute!)
    }

    /// First instant at or after `from` where `isActive` equals `target`, by brute force.
    private func firstMinute(_ target: Bool, from: Date, schedule: Schedule) -> Date? {
        for step in 0...(3 * 24 * 60) {
            let t = eastern.date(byAdding: .minute, value: step, to: from)!
            if schedule.isActive(at: t, calendar: eastern) == target { return t }
        }
        return nil
    }

    private var daily: Schedule {
        Schedule(enabled: true, days: [1, 2, 3, 4, 5, 6, 7], startMinute: 10 * 60, stopMinute: 12 * 60)
    }

    // MARK: - The schedule keeps wall-clock time

    func testSpringForwardMakesTheDayBetweenStartsShorter() {
        let saturday = local(2026, 3, 7, 10, 0)
        let next = daily.nextStart(after: saturday, calendar: eastern)
        XCTAssertEqual(next.map(wallClock), "03-08 10:00")
        // 23 hours of real time, because an hour of it doesn't exist.
        XCTAssertEqual(next?.timeIntervalSince(saturday), 23 * 3600)
    }

    func testFallBackMakesTheDayBetweenStartsLonger() {
        let saturday = local(2026, 10, 31, 10, 0)
        let next = daily.nextStart(after: saturday, calendar: eastern)
        XCTAssertEqual(next.map(wallClock), "11-01 10:00")
        XCTAssertEqual(next?.timeIntervalSince(saturday), 25 * 3600)
    }

    /// A window whose start falls inside the spring-forward gap: local 02:30 does not exist on
    /// 2026-03-08. `nextStart` must land on the first instant the schedule is actually active —
    /// this is the case where `Calendar.nextDate`'s matching policy decides the answer, and the
    /// wrong one silently reports a start a week later.
    func testStartInsideTheSpringForwardGap() {
        let schedule = Schedule(enabled: true, days: [1], startMinute: 2 * 60 + 30, stopMinute: 4 * 60)
        let midnight = local(2026, 3, 8, 0, 0)

        let edge = daily.isActive(at: midnight, calendar: eastern)
            ? nil : schedule.nextStart(after: midnight, calendar: eastern)
        XCTAssertEqual(edge, firstMinute(true, from: midnight, schedule: schedule))
        XCTAssertEqual(edge.map(wallClock), "03-08 03:00")
    }

    func testWindowSpanningTheGapIsShorterInRealTime() {
        let schedule = Schedule(enabled: true, days: [1], startMinute: 1 * 60, stopMinute: 4 * 60)
        let midnight = local(2026, 3, 8, 0, 0)
        let start = firstMinute(true, from: midnight, schedule: schedule)!
        let stop = firstMinute(false, from: start, schedule: schedule)!

        XCTAssertEqual(wallClock(start), "03-08 01:00")
        XCTAssertEqual(wallClock(stop), "03-08 04:00")            // the wall says three hours...
        XCTAssertEqual(stop.timeIntervalSince(start), 2 * 3600)   // ...the room gets two
        XCTAssertEqual(schedule.nextStop(after: start, calendar: eastern), stop)
    }

    // MARK: - A hold's cap keeps absolute time

    func testCapIsFourRealHoursAcrossTheGap() {
        let setAt = local(2026, 3, 8, 1, 30)
        let hold = RunHold.starting(true, at: setAt, schedule: Schedule(enabled: false), calendar: eastern)
        XCTAssertTrue(hold.capped)
        XCTAssertEqual(hold.endsAt.timeIntervalSince(setAt), RunHold.maxDuration)
        // Four hours of real time reads as five on the wall: 06:30, not 05:30.
        XCTAssertEqual(wallClock(hold.endsAt), "03-08 06:30")
    }

    // MARK: - The repeated hour: characterization, not a fix

    /// Local 01:00–01:59 happens twice on 2026-11-01. `isActive` reads only wall-clock
    /// components, so it is true during *both* passes, while `nextStop` resolves to the first.
    /// A window ending at 01:30 therefore stops, and then comes back for the repeated hour.
    ///
    /// Pinned rather than fixed. The ambiguity is inherent to wall-clock scheduling and already
    /// existed in `isWithinWindow`; the blast radius is one extra hour of publishing at 01:00,
    /// once a year, on a feeder whose schedule runs Sunday mornings. A special case here would
    /// cost more than it saves — but it should be a decision, not a surprise.
    func testFallBackRepeatsAnEarlyMorningWindow() {
        let schedule = Schedule(enabled: true, days: [1], startMinute: 30, stopMinute: 60 + 30)
        let midnight = local(2026, 11, 1, 0, 0)

        let start = firstMinute(true, from: midnight, schedule: schedule)!
        let stop = firstMinute(false, from: start, schedule: schedule)!
        XCTAssertEqual(wallClock(start), "11-01 00:30")
        XCTAssertEqual(wallClock(stop), "11-01 01:30")
        // The first 01:30 is EDT, so the first pass is one real hour long.
        XCTAssertEqual(stop.timeIntervalSince(start), 3600)
        XCTAssertEqual(schedule.nextStop(after: start, calendar: eastern), stop)

        // ...and then the wall clock rewinds into the window again.
        let secondPass = firstMinute(true, from: stop, schedule: schedule)
        XCTAssertEqual(secondPass.map(wallClock), "11-01 01:00")
        XCTAssertEqual(secondPass?.timeIntervalSince(stop), 1800)
    }
}
