import XCTest
@testable import AudioFeederCore

/// The rules that decide how long the server's answer may be acted on. These live in the core
/// precisely so they can be tested: the controller that used to hold them has no test target,
/// and getting them wrong is issue #111 again — a feeder publishing into the wrong doc.
final class SessionResolutionTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testNothingIsFreshBeforeAnythingIsAsked() {
        let session = SessionResolution()
        XCTAssertNil(session.docID)
        XCTAssertFalse(session.isFresh(at: t0))
    }

    func testAnAnswerIsFreshForItsLifetime() {
        var session = SessionResolution(lifetime: 60)
        session.record(docID: "doc-2026-08-30", at: t0)
        XCTAssertEqual(session.docID, "doc-2026-08-30")
        XCTAssertTrue(session.isFresh(at: t0))
        XCTAssertTrue(session.isFresh(at: t0.addingTimeInterval(59)))
        XCTAssertFalse(session.isFresh(at: t0.addingTimeInterval(60)))
    }

    /// The whole point of the expiry. A Mac asleep between two Sunday windows never sees the
    /// off-schedule tick that forgets, so it wakes up *inside* the next service still holding
    /// last week's answer. Stale is what stops it publishing there.
    func testLastWeeksAnswerIsNotFreshAWeekLater() {
        var session = SessionResolution()
        session.record(docID: "doc-2026-08-23", at: t0)
        XCTAssertFalse(session.isFresh(at: t0.addingTimeInterval(7 * 24 * 3600)))
        // Still remembered, though: a live pipeline keeps publishing into the room it is in
        // while the re-ask is in flight. Expiry forbids *starting* on it, not knowing it.
        XCTAssertEqual(session.docID, "doc-2026-08-23")
    }

    func testRecordingTheSameAnswerIsNotAMove() {
        var session = SessionResolution()
        session.record(docID: "doc-2026-08-30", at: t0)
        XCTAssertFalse(session.record(docID: "doc-2026-08-30", at: t0.addingTimeInterval(60)))
    }

    /// The first answer of a run is not a move — there was no pipeline to rebuild.
    func testTheFirstAnswerIsNotAMove() {
        var session = SessionResolution()
        XCTAssertFalse(session.record(docID: "doc-2026-08-30", at: t0))
    }

    /// An operator pinned a different doc mid-service. This is the signal that rebuilds the
    /// pipeline, so it has to be reported exactly once, when the answer actually changes.
    func testAPinMidRunReportsAMove() {
        var session = SessionResolution()
        session.record(docID: "doc-2026-08-30", at: t0)
        XCTAssertTrue(session.record(docID: "doc-2026-08-23", at: t0.addingTimeInterval(60)))
        XCTAssertEqual(session.docID, "doc-2026-08-23")
        XCTAssertTrue(session.isFresh(at: t0.addingTimeInterval(60)))
    }

    /// A failed re-check behind a working pipeline must not drop the answer: the doc question
    /// can wait a minute, the broadcast cannot.
    func testAFailedRecheckKeepsTheAnswerAndDefersTheNextAsk() {
        var session = SessionResolution(lifetime: 60)
        session.record(docID: "doc-2026-08-30", at: t0)
        let stale = t0.addingTimeInterval(60)
        XCTAssertFalse(session.isFresh(at: stale))

        session.extendFreshness(from: stale)
        XCTAssertEqual(session.docID, "doc-2026-08-30")
        XCTAssertTrue(session.isFresh(at: stale))
        XCTAssertFalse(session.isFresh(at: stale.addingTimeInterval(60)))
    }

    /// Nothing to extend. Guarded so a failure before the first successful answer can't
    /// manufacture a fresh `nil` for the caller to start a pipeline on.
    func testExtendingWithNoAnswerStaysEmpty() {
        var session = SessionResolution()
        session.extendFreshness(from: t0)
        XCTAssertNil(session.docID)
        XCTAssertFalse(session.isFresh(at: t0))
    }

    func testForgettingDropsTheAnswerOutright() {
        var session = SessionResolution()
        session.record(docID: "doc-2026-08-30", at: t0)
        session.forget()
        XCTAssertNil(session.docID)
        XCTAssertFalse(session.isFresh(at: t0))
    }
}
