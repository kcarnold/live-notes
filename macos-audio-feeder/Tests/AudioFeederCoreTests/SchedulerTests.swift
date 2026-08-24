import XCTest
@testable import AudioFeederCore

final class SchedulerTests: XCTestCase {

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    /// Build a Date at a given UTC weekday/time. 2024-01-07 is a Sunday.
    private func date(weekday: Int, hour: Int, minute: Int) -> Date {
        // 2024-01-07 = Sunday(1) ... 2024-01-13 = Saturday(7).
        let day = 7 + (weekday - 1)
        var c = DateComponents()
        c.year = 2024; c.month = 1; c.day = day; c.hour = hour; c.minute = minute
        return utc.date(from: c)!
    }

    private func isOn(_ weekday: Int, _ hour: Int, _ minute: Int, _ s: Schedule) -> Bool {
        Scheduler.shouldRun(now: date(weekday: weekday, hour: hour, minute: minute),
                            schedule: s, hold: nil, calendar: utc)
    }

    // MARK: - The window itself (unchanged semantics; these predate the hold)

    func testDisabledScheduleNeverRuns() {
        let s = Schedule(isEnabled: false, days: [1], startMinute: 0, stopMinute: 1440 - 1)
        XCTAssertFalse(isOn(1, 12, 0, s))
    }

    func testInsideSameDayWindow() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertTrue(isOn(1, 10, 0, s))
        XCTAssertTrue(isOn(1, 11, 59, s))
    }

    func testWindowBoundariesAreHalfOpen() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertTrue(isOn(1, 10, 0, s))    // start inclusive
        XCTAssertFalse(isOn(1, 12, 0, s))   // stop exclusive
        XCTAssertFalse(isOn(1, 9, 59, s))   // before start
    }

    func testWrongDayDoesNotRun() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertFalse(isOn(2, 11, 0, s))
    }

    func testEmptyWindowNeverRuns() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 600, stopMinute: 600)
        XCTAssertFalse(isOn(1, 10, 0, s))
    }

    func testWrapPastMidnight() {
        // Sunday 23:00 -> Monday 01:00, anchored to Sunday(1).
        let s = Schedule(isEnabled: true, days: [1], startMinute: 23 * 60, stopMinute: 1 * 60)
        XCTAssertTrue(isOn(1, 23, 30, s))    // Sunday late night: inside
        XCTAssertTrue(isOn(2, 0, 30, s))     // Monday early: belongs to Sunday's window
        XCTAssertFalse(isOn(2, 1, 0, s))     // Monday after stop: out
        XCTAssertFalse(isOn(1, 22, 59, s))   // Sunday before start: out
    }

    func testWeekdayHelpersWrap() {
        XCTAssertEqual(Scheduler.previousWeekday(1), 7)
        XCTAssertEqual(Scheduler.previousWeekday(2), 1)
        XCTAssertEqual(Scheduler.previousWeekday(7), 6)
        XCTAssertEqual(Scheduler.nextWeekday(7), 1)
        XCTAssertEqual(Scheduler.nextWeekday(1), 2)
        XCTAssertEqual(Scheduler.nextWeekday(6), 7)
    }

    // MARK: - Edge lookup
    //
    // `nextStart`/`nextStop` are checked against an independent minute-by-minute sweep of
    // `isActive` rather than against hand-written expectations. A sweep is a bad implementation
    // and a good oracle: it is the definition of "the first minute this flips", so agreement
    // means the Calendar-based lookup reproduces the window semantics exactly — including the
    // wrapping case, where the stop edge lands on the day *after* an active day.

    /// First minute in the next week at which `isActive` becomes `target`, by brute force.
    private func sweepForEdge(_ target: Bool, after: Date, schedule: Schedule) -> Date? {
        var previous = schedule.isActive(at: after, calendar: utc)
        for step in 1...(8 * 24 * 60) {
            let t = utc.date(byAdding: .minute, value: step, to: after)!
            let now = schedule.isActive(at: t, calendar: utc)
            if now == target && previous != target { return t }
            previous = now
        }
        return nil
    }

    private func assertEdgesMatchSweep(_ schedule: Schedule,
                                       from: Date,
                                       file: StaticString = #filePath,
                                       line: UInt = #line) {
        XCTAssertEqual(schedule.nextStart(after: from, calendar: utc),
                       sweepForEdge(true, after: from, schedule: schedule),
                       "nextStart disagrees with the sweep", file: file, line: line)
        XCTAssertEqual(schedule.nextStop(after: from, calendar: utc),
                       sweepForEdge(false, after: from, schedule: schedule),
                       "nextStop disagrees with the sweep", file: file, line: line)
    }

    func testEdgesAgreeWithASweptWeek() {
        let sameDay = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        let wrapping = Schedule(isEnabled: true, days: [7], startMinute: 23 * 60, stopMinute: 1 * 60)
        let manyDays = Schedule(isEnabled: true, days: [2, 4, 6], startMinute: 9 * 60, stopMinute: 17 * 60)

        // Probe from a spread of starting points: before, inside and after a window, and from
        // the wrapping window's early-morning tail.
        for schedule in [sameDay, wrapping, manyDays] {
            for weekday in 1...7 {
                for hour in [0, 9, 10, 11, 12, 23] {
                    assertEdgesMatchSweep(schedule,
                                          from: date(weekday: weekday, hour: hour, minute: 30))
                }
            }
        }
    }

    func testEdgesAreNilForAnInertSchedule() {
        let from = date(weekday: 1, hour: 9, minute: 0)
        for inert in [Schedule(isEnabled: false, days: [1], startMinute: 600, stopMinute: 720),
                      Schedule(isEnabled: true, days: [], startMinute: 600, stopMinute: 720),
                      Schedule(isEnabled: true, days: [1], startMinute: 600, stopMinute: 600)] {
            XCTAssertNil(inert.nextStart(after: from, calendar: utc))
            XCTAssertNil(inert.nextStop(after: from, calendar: utc))
        }
    }

    func testEdgesAreStrictlyAfterTheGivenInstant() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        // Standing exactly on an edge must yield the *next* one, a week away — not this one.
        XCTAssertEqual(s.nextStart(after: date(weekday: 1, hour: 10, minute: 0), calendar: utc),
                       utc.date(byAdding: .day, value: 7, to: date(weekday: 1, hour: 10, minute: 0)))
        XCTAssertEqual(s.nextStop(after: date(weekday: 1, hour: 9, minute: 0), calendar: utc),
                       date(weekday: 1, hour: 12, minute: 0))
    }

    // MARK: - Holds

    func testStartEarlyRunsIntoTheScheduledWindow() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        let hold = RunHold.starting(true, at: date(weekday: 1, hour: 9, minute: 40),
                                    schedule: s, calendar: utc)
        // The hold itself only reaches the scheduled start...
        XCTAssertEqual(hold.endsAt, date(weekday: 1, hour: 10, minute: 0))
        XCTAssertFalse(hold.isCapped)

        func on(_ h: Int, _ m: Int) -> Bool {
            Scheduler.shouldRun(now: date(weekday: 1, hour: h, minute: m),
                                schedule: s, hold: hold, calendar: utc)
        }
        XCTAssertFalse(on(9, 39))   // before the press
        XCTAssertTrue(on(9, 41))    // held on, early
        XCTAssertTrue(on(11, 0))    // hold expired; the schedule carries the run
        XCTAssertFalse(on(12, 1))   // and ends it normally
    }

    func testStopEarlyEndsThisRunOnly() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        let hold = RunHold.starting(false, at: date(weekday: 1, hour: 11, minute: 15),
                                    schedule: s, calendar: utc)
        XCTAssertEqual(hold.endsAt, date(weekday: 1, hour: 12, minute: 0))

        func on(_ d: Date) -> Bool {
            Scheduler.shouldRun(now: d, schedule: s, hold: hold, calendar: utc)
        }
        XCTAssertFalse(on(date(weekday: 1, hour: 11, minute: 16)))
        XCTAssertFalse(on(date(weekday: 1, hour: 11, minute: 59)))
        // Next Sunday is unaffected — the whole point of not persisting a mode.
        let nextSunday = utc.date(byAdding: .day, value: 7,
                                  to: date(weekday: 1, hour: 10, minute: 1))!
        XCTAssertTrue(on(nextSunday))
    }

    /// The failure mode that rules out "expire the hold once the schedule agrees with it": the
    /// window closes again inside the hold's lifetime, and a state-comparing rule would read
    /// that as the hold applying once more.
    func testHoldDoesNotResurrectWhenTheWindowClosesAgain() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 11 * 60)
        let hold = RunHold.starting(true, at: date(weekday: 1, hour: 9, minute: 40),
                                    schedule: s, calendar: utc)
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 11, minute: 30),
                                           schedule: s, hold: hold, calendar: utc))
    }

    func testHoldIsCappedWhenNoEdgeIsNear() {
        let off = Schedule(isEnabled: false)
        let setAt = date(weekday: 4, hour: 14, minute: 0)
        let hold = RunHold.starting(true, at: setAt, schedule: off, calendar: utc)
        XCTAssertTrue(hold.isCapped)
        XCTAssertEqual(hold.endsAt, setAt.addingTimeInterval(RunHold.maxDuration))
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 4, hour: 17, minute: 59),
                                          schedule: off, hold: hold, calendar: utc))
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 4, hour: 18, minute: 1),
                                           schedule: off, hold: hold, calendar: utc))
    }

    /// A far-off schedule must not stretch a hold: the next start is days away, so the cap wins.
    func testDistantScheduleStillCapsTheHold() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        let setAt = date(weekday: 4, hour: 14, minute: 0)   // Wednesday afternoon
        let hold = RunHold.starting(true, at: setAt, schedule: s, calendar: utc)
        XCTAssertTrue(hold.isCapped)
        XCTAssertEqual(hold.endsAt, setAt.addingTimeInterval(RunHold.maxDuration))
    }

    // MARK: - Editing the schedule under a live hold

    func testExtendingTheWindowKeepsAStoppedRunStopped() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        let setAt = date(weekday: 1, hour: 11, minute: 15)
        let hold = RunHold.starting(false, at: setAt, schedule: s, calendar: utc)

        var extended = s
        extended.stopMinute = 14 * 60
        let moved = hold.recomputed(for: extended, calendar: utc)

        XCTAssertEqual(moved.endsAt, date(weekday: 1, hour: 14, minute: 0))
        // Without the recompute this is the moment the feeder would come back on by itself.
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 12, minute: 1),
                                           schedule: extended, hold: moved, calendar: utc))
    }

    func testRecomputeKeepsTheCapAnchoredToThePress() {
        let off = Schedule(isEnabled: false)
        let setAt = date(weekday: 4, hour: 14, minute: 0)
        var hold = RunHold.starting(true, at: setAt, schedule: off, calendar: utc)

        // Repeated edits must not walk the ceiling forward.
        for _ in 0..<5 { hold = hold.recomputed(for: off, calendar: utc) }
        XCTAssertEqual(hold.endsAt, setAt.addingTimeInterval(RunHold.maxDuration))
    }

    func testShorteningTheWindowIntoThePastEndsTheHold() {
        let s = Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 14 * 60)
        let setAt = date(weekday: 1, hour: 10, minute: 30)
        let hold = RunHold.starting(false, at: setAt, schedule: s, calendar: utc)

        var shortened = s
        shortened.stopMinute = 10 * 60 + 45
        let moved = hold.recomputed(for: shortened, calendar: utc)

        XCTAssertEqual(moved.endsAt, date(weekday: 1, hour: 10, minute: 45))
        XCTAssertFalse(moved.isLive(at: date(weekday: 1, hour: 11, minute: 0)))
    }
}
