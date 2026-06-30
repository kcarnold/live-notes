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

    func testConfigCodableRoundTrip() throws {
        let cfg = FeederConfig(serverURL: "https://example.org",
                               docIDOverride: "doc-x",
                               deviceUID: "AppleUSBAudioEngine:...:1",
                               channelIndex: 7,
                               schedule: Schedule(enabled: true, days: [1, 4], startMinute: 600, stopMinute: 720),
                               manualOverride: .forceOn)
        let data = try JSONEncoder().encode(cfg)
        let decoded = try JSONDecoder().decode(FeederConfig.self, from: data)
        XCTAssertEqual(cfg, decoded)
    }
}
