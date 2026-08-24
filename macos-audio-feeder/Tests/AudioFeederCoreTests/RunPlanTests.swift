import XCTest
@testable import AudioFeederCore

/// The popover's one sentence, pinned by exact string.
///
/// Worth the brittleness: this sentence is the only thing standing between an operator and a
/// feeder that looks identical whether it is five minutes from going live or switched off
/// forever. Testing it here means it can be checked without Xcode, a room, or a sound board.
final class RunPlanTests: XCTestCase {

    /// 2024-01-07 is a Sunday, so weekday 1...7 maps to 2024-01-07...13.
    private func date(weekday: Int, hour: Int, minute: Int) -> Date {
        var c = DateComponents()
        c.year = 2024; c.month = 1; c.day = 7 + (weekday - 1); c.hour = hour; c.minute = minute
        return utc.date(from: c)!
    }

    private func plan(_ now: Date, _ schedule: Schedule, _ hold: RunHold? = nil) -> RunPlan {
        RunPlan.evaluate(now: now, schedule: schedule, hold: hold, calendar: utc)
    }

    private var sundayMorning: Schedule {
        Schedule(isEnabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
    }

    func testOffAndWaitingNamesTheNextRun() {
        let p = plan(date(weekday: 1, hour: 9, minute: 0), sundayMorning)
        XCTAssertFalse(p.isOn)
        XCTAssertFalse(p.isInert)
        XCTAssertEqual(p.summary, "Next run Sun 10:00–12:00.")
    }

    func testAWrappingNextRunSaysWhichDayItEndsOn() {
        let overnight = Schedule(isEnabled: true, days: [7], startMinute: 23 * 60, stopMinute: 60)
        XCTAssertEqual(plan(date(weekday: 1, hour: 9, minute: 0), overnight).summary,
                       "Next run Sat 23:00–01:00 the next day.")
    }

    func testRunningOnScheduleNamesTheStop() {
        let p = plan(date(weekday: 1, hour: 10, minute: 30), sundayMorning)
        XCTAssertTrue(p.isOn)
        XCTAssertFalse(p.isHeld)
        XCTAssertEqual(p.summary, "Runs until 12:00.")
    }

    func testStartedEarlyStillNamesTheScheduledStop() {
        // The hold expires at 10:00 and the schedule carries the run to 12:00 — so the useful
        // time to quote is the one the run actually ends at, not the hold's own expiry.
        let setAt = date(weekday: 1, hour: 9, minute: 40)
        let hold = RunHold.starting(true, at: setAt, schedule: sundayMorning, calendar: utc)
        let p = plan(date(weekday: 1, hour: 9, minute: 45), sundayMorning, hold)
        XCTAssertTrue(p.isOn)
        XCTAssertTrue(p.isHeld)
        XCTAssertEqual(p.summary, "Started early — runs until 12:00.")
    }

    func testStoppedEarlyNamesTheNextRun() {
        let setAt = date(weekday: 1, hour: 11, minute: 15)
        let hold = RunHold.starting(false, at: setAt, schedule: sundayMorning, calendar: utc)
        let p = plan(date(weekday: 1, hour: 11, minute: 20), sundayMorning, hold)
        XCTAssertFalse(p.isOn)
        XCTAssertTrue(p.isHeld)
        XCTAssertEqual(p.summary, "Stopped early — next run Sun 10:00–12:00.")
    }

    func testACappedHoldNamesItsOwnEnd() {
        let off = Schedule(isEnabled: false)
        let setAt = date(weekday: 4, hour: 14, minute: 0)
        let hold = RunHold.starting(true, at: setAt, schedule: off, calendar: utc)
        let p = plan(date(weekday: 4, hour: 14, minute: 5), off, hold)
        XCTAssertTrue(p.isOn)
        XCTAssertEqual(p.summary, "Started early — runs until 18:00.")
        // Still orange: nothing will start this again once the four hours are up.
        XCTAssertTrue(p.isInert)
    }

    func testAnExpiredHoldStopsBeingMentioned() {
        let setAt = date(weekday: 1, hour: 9, minute: 40)
        let hold = RunHold.starting(true, at: setAt, schedule: sundayMorning, calendar: utc)
        // 11:00 is past the hold's 10:00 expiry; the schedule owns the run now.
        let p = plan(date(weekday: 1, hour: 11, minute: 0), sundayMorning, hold)
        XCTAssertFalse(p.isHeld)
        XCTAssertEqual(p.summary, "Runs until 12:00.")
    }

    /// Each inert schedule keeps the sentence that names *which* way it is inert — they look
    /// identical in the settings window's day-button row otherwise.
    func testInertSchedulesKeepTheirOwnSentences() {
        let cases: [(Schedule, String)] = [
            (Schedule(isEnabled: false, days: [1], startMinute: 600, stopMinute: 720),
             "Schedule off — nothing will start the feeder on its own."),
            (Schedule(isEnabled: true, days: [], startMinute: 600, stopMinute: 720),
             "No days selected — the schedule will never start the feeder."),
            (Schedule(isEnabled: true, days: [1], startMinute: 600, stopMinute: 600),
             "Start and stop are the same time — the schedule will never start the feeder."),
        ]
        for (schedule, expected) in cases {
            let p = plan(date(weekday: 1, hour: 9, minute: 0), schedule)
            XCTAssertEqual(p.summary, expected)
            XCTAssertTrue(p.isInert, "\(schedule) should warn")
            XCTAssertEqual(p.summary, schedule.summary, "must stay the settings window's wording")
        }
    }

    func testWarnsTracksWillStartUnattended() {
        XCTAssertFalse(plan(date(weekday: 1, hour: 9, minute: 0), sundayMorning).isInert)
        XCTAssertEqual(plan(date(weekday: 1, hour: 9, minute: 0), sundayMorning).isInert,
                       !FeederConfig(schedule: sundayMorning).willStartUnattended)
    }
}
