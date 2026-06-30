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

    func testManualForceOnAlwaysRuns() {
        let s = Schedule(enabled: false)
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 1, hour: 3, minute: 0),
                                          schedule: s, manualOverride: .forceOn, calendar: utc))
    }

    func testManualForceOffAlwaysStops() {
        let s = Schedule(enabled: true, days: [1], startMinute: 0, stopMinute: 24 * 60 - 1)
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 12, minute: 0),
                                           schedule: s, manualOverride: .forceOff, calendar: utc))
    }

    func testDisabledScheduleNeverRuns() {
        let s = Schedule(enabled: false, days: [1], startMinute: 0, stopMinute: 1440 - 1)
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 12, minute: 0),
                                           schedule: s, manualOverride: .off, calendar: utc))
    }

    func testInsideSameDayWindow() {
        let s = Schedule(enabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 1, hour: 10, minute: 0),
                                          schedule: s, manualOverride: .off, calendar: utc))
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 1, hour: 11, minute: 59),
                                          schedule: s, manualOverride: .off, calendar: utc))
    }

    func testWindowBoundariesAreHalfOpen() {
        let s = Schedule(enabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        // start inclusive
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 1, hour: 10, minute: 0),
                                          schedule: s, manualOverride: .off, calendar: utc))
        // stop exclusive
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 12, minute: 0),
                                           schedule: s, manualOverride: .off, calendar: utc))
        // before start
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 9, minute: 59),
                                           schedule: s, manualOverride: .off, calendar: utc))
    }

    func testWrongDayDoesNotRun() {
        let s = Schedule(enabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 2, hour: 11, minute: 0),
                                           schedule: s, manualOverride: .off, calendar: utc))
    }

    func testEmptyWindowNeverRuns() {
        let s = Schedule(enabled: true, days: [1], startMinute: 600, stopMinute: 600)
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 10, minute: 0),
                                           schedule: s, manualOverride: .off, calendar: utc))
    }

    func testWrapPastMidnight() {
        // Sunday 23:00 -> Monday 01:00, anchored to Sunday(1).
        let s = Schedule(enabled: true, days: [1], startMinute: 23 * 60, stopMinute: 1 * 60)
        // Sunday late night: inside.
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 1, hour: 23, minute: 30),
                                          schedule: s, manualOverride: .off, calendar: utc))
        // Monday early morning: belongs to Sunday's window.
        XCTAssertTrue(Scheduler.shouldRun(now: date(weekday: 2, hour: 0, minute: 30),
                                          schedule: s, manualOverride: .off, calendar: utc))
        // Monday after stop: out.
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 2, hour: 1, minute: 0),
                                           schedule: s, manualOverride: .off, calendar: utc))
        // Sunday before start: out.
        XCTAssertFalse(Scheduler.shouldRun(now: date(weekday: 1, hour: 22, minute: 59),
                                           schedule: s, manualOverride: .off, calendar: utc))
    }

    func testPreviousWeekdayWraps() {
        XCTAssertEqual(Scheduler.previousWeekday(1), 7)
        XCTAssertEqual(Scheduler.previousWeekday(2), 1)
        XCTAssertEqual(Scheduler.previousWeekday(7), 6)
    }
}
