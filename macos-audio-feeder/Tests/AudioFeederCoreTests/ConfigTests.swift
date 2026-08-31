import XCTest
@testable import AudioFeederCore

final class ConfigTests: XCTestCase {

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    func testResolvedDocIDDefaultsToDatedDoc() {
        var c = DateComponents(); c.year = 2025; c.month = 3; c.day = 5
        let now = utc.date(from: c)!
        let cfg = FeederConfig(docIDOverride: nil)
        XCTAssertEqual(cfg.resolvedDocID(now: now, calendar: utc), "doc-2025-03-05")
    }

    func testResolvedDocIDHonorsOverride() {
        let cfg = FeederConfig(docIDOverride: "doc-special")
        XCTAssertEqual(cfg.resolvedDocID(), "doc-special")
    }

    func testBlankOverrideFallsBackToDated() {
        var c = DateComponents(); c.year = 2025; c.month = 12; c.day = 31
        let now = utc.date(from: c)!
        let cfg = FeederConfig(docIDOverride: "   ")
        XCTAssertEqual(cfg.resolvedDocID(now: now, calendar: utc), "doc-2025-12-31")
    }

    func testHHMMRoundTrip() {
        XCTAssertEqual(Schedule.formatHHMM(10 * 60 + 5), "10:05")
        XCTAssertEqual(Schedule.parseHHMM("10:05"), 10 * 60 + 5)
        XCTAssertNil(Schedule.parseHHMM("24:00"))
        XCTAssertNil(Schedule.parseHHMM("bad"))
        XCTAssertNil(Schedule.parseHHMM("10:60"))
    }

    // MARK: - The sentence the settings window shows under the day buttons
    //
    // This is the part of the UI that says whether the feeder will actually run, so it is
    // worth pinning: the highlight on a day button can't distinguish "Wednesday is selected"
    // from "Wednesday is selected and the schedule is switched off".

    func testWeekdayLabels() {
        XCTAssertEqual(Schedule.weekdaySymbol(1), "Sun")
        XCTAssertEqual(Schedule.weekdaySymbol(7), "Sat")
        XCTAssertEqual(Schedule.weekdayName(4), "Wednesday")
        // Out of range is a bug elsewhere, but must not trap in a view body.
        XCTAssertEqual(Schedule.weekdaySymbol(0), "?")
        XCTAssertEqual(Schedule.weekdayName(8), "?")
    }

    func testDaysDescriptionCollapsesCommonSets() {
        func days(_ d: Set<Int>) -> String { Schedule(days: d).daysDescription }
        XCTAssertEqual(days([1, 2, 3, 4, 5, 6, 7]), "every day")
        XCTAssertEqual(days([2, 3, 4, 5, 6]), "weekdays")
        XCTAssertEqual(days([1, 7]), "weekends")
        XCTAssertEqual(days([]), "no days")
        // Otherwise: listed, always in Sunday-first calendar order.
        XCTAssertEqual(days([4, 1]), "Sun, Wed")
    }

    func testSummaryNamesEveryWayAScheduleCanBeInert() {
        // Switched off, however full the day row looks.
        XCTAssertEqual(Schedule(enabled: false, days: [1, 2, 3, 4, 5, 6, 7]).summary,
                       "Schedule off — nothing will start the feeder on its own.")
        XCTAssertFalse(Schedule(enabled: false, days: [1]).willEverRun)

        // Enabled, sane window, but nothing selected.
        XCTAssertEqual(Schedule(enabled: true, days: []).summary,
                       "No days selected — the schedule will never start the feeder.")
        XCTAssertFalse(Schedule(enabled: true, days: []).willEverRun)

        // Enabled, days selected, but an empty window (`Scheduler` treats start == stop as off).
        let noWindow = Schedule(enabled: true, days: [1], startMinute: 600, stopMinute: 600)
        XCTAssertEqual(noWindow.summary,
                       "Start and stop are the same time — the schedule will never start the feeder.")
        XCTAssertFalse(noWindow.willEverRun)
    }

    func testSummaryDescribesALiveSchedule() {
        let sunday = Schedule(enabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertEqual(sunday.summary, "Runs Sun, 10:00–12:00.")
        XCTAssertTrue(sunday.willEverRun)

        // A window that wraps past midnight is anchored to its start day, so say so.
        let overnight = Schedule(enabled: true, days: [7], startMinute: 23 * 60, stopMinute: 60)
        XCTAssertEqual(overnight.summary, "Runs Sat, 23:00–01:00 the next day.")
        XCTAssertTrue(overnight.willEverRun)
    }

    /// `willEverRun` must agree with the thing that actually decides: `Scheduler.shouldRun`.
    func testWillEverRunAgreesWithScheduler() {
        // 2024-01-07 is a Sunday, so day 7...13 is one full Sun-to-Sat week.
        func date(dayOffset: Int, minuteOfDay: Int) -> Date {
            var c = DateComponents()
            c.year = 2024; c.month = 1; c.day = 7 + dayOffset
            c.hour = minuteOfDay / 60; c.minute = minuteOfDay % 60
            return utc.date(from: c)!
        }

        let inert = [Schedule(enabled: false, days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, stopMinute: 1439),
                     Schedule(enabled: true, days: [], startMinute: 0, stopMinute: 1439),
                     Schedule(enabled: true, days: [1, 2, 3, 4, 5, 6, 7], startMinute: 600, stopMinute: 600)]
        for schedule in inert {
            XCTAssertFalse(schedule.willEverRun)
            // Sweep a whole week at minute resolution: nothing anywhere should start it.
            for dayOffset in 0..<7 {
                for minute in 0..<(24 * 60) {
                    XCTAssertFalse(Scheduler.shouldRun(now: date(dayOffset: dayOffset, minuteOfDay: minute),
                                                       schedule: schedule,
                                                       hold: nil,
                                                       calendar: utc),
                                   "\(schedule) claimed inert but runs on day \(dayOffset) at minute \(minute)")
                }
            }
        }

        // And the converse: a schedule that says it will run, does.
        let live = Schedule(enabled: true, days: [1], startMinute: 10 * 60, stopMinute: 12 * 60)
        XCTAssertTrue(live.willEverRun)
        XCTAssertTrue(Scheduler.shouldRun(now: date(dayOffset: 0, minuteOfDay: 11 * 60),
                                          schedule: live, hold: nil, calendar: utc))
    }

    // MARK: - Will anything start this on its own?

    func testWillStartUnattendedIsTheScheduleAlone() {
        let live = Schedule(enabled: true, days: [1], startMinute: 600, stopMinute: 720)
        let off = Schedule(enabled: false, days: [1], startMinute: 600, stopMinute: 720)

        // There is no longer a second control that can override this answer — which is the
        // whole point: a hold is transient and can't leave an install silently parked.
        XCTAssertTrue(FeederConfig(schedule: live).willStartUnattended)
        XCTAssertFalse(FeederConfig(schedule: off).willStartUnattended)
    }

    /// `willStartUnattended` must not become a second opinion: if it says nothing will start
    /// the feeder, `Scheduler.shouldRun` must agree across a whole week.
    func testWillStartUnattendedAgreesWithScheduler() {
        func date(dayOffset: Int, minuteOfDay: Int) -> Date {
            var c = DateComponents()
            c.year = 2024; c.month = 1; c.day = 7 + dayOffset   // 2024-01-07 is a Sunday
            c.hour = minuteOfDay / 60; c.minute = minuteOfDay % 60
            return utc.date(from: c)!
        }
        let configs = [FeederConfig(schedule: Schedule(enabled: false)),
                       FeederConfig(schedule: Schedule(enabled: true, days: [],
                                                       startMinute: 0, stopMinute: 1439))]
        for config in configs {
            XCTAssertFalse(config.willStartUnattended)
            for dayOffset in 0..<7 {
                for minute in stride(from: 0, to: 24 * 60, by: 7) {
                    XCTAssertFalse(Scheduler.shouldRun(now: date(dayOffset: dayOffset, minuteOfDay: minute),
                                                       schedule: config.schedule,
                                                       hold: nil,
                                                       calendar: utc))
                }
            }
        }
    }

    func testConfigCodableRoundTrip() throws {
        let cfg = FeederConfig(serverURL: "https://example.org",
                               docIDOverride: "doc-x",
                               deviceUID: "AppleUSBAudioEngine:...:1",
                               channelIndex: 7,
                               schedule: Schedule(enabled: true, days: [1, 4], startMinute: 600, stopMinute: 720))
        let data = try JSONEncoder().encode(cfg)
        let decoded = try JSONDecoder().decode(FeederConfig.self, from: data)
        XCTAssertEqual(cfg, decoded)
    }

    /// The deployed config predates the hold and still carries a `manualOverride` key. Decoding
    /// must ignore it rather than throw, so an existing install comes up on its schedule.
    func testLegacyConfigWithAModeStillDecodes() throws {
        let json = """
        {"serverURL":"https://example.org","channelIndex":2,"manualOverride":"forceOn",
         "schedule":{"enabled":true,"days":[1],"startMinute":600,"stopMinute":720}}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(FeederConfig.self, from: json)
        XCTAssertEqual(decoded.channelIndex, 2)
        XCTAssertTrue(decoded.schedule.enabled)
    }
}
