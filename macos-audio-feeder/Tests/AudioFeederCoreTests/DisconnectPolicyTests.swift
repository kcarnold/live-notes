import XCTest
@testable import AudioFeederCore

final class DisconnectPolicyTests: XCTestCase {

    // MARK: - Stand down (retrying would fight a person)

    func testDuplicateIdentityStandsDown() {
        // The browser broadcast page joins as the same `organizer-host` identity and wins.
        // Reconnecting would evict it right back, and the two would trade the room forever.
        XCTAssertEqual(DisconnectPolicy.response(to: .duplicateIdentity),
                       .standDown(message: "Taken over by the broadcast page"))
    }

    func testParticipantRemovedStandsDown() {
        // Nothing in live-notes removes participants, so this is a human with the LiveKit
        // dashboard or CLI deliberately kicking the feeder — i.e. the remote stop button.
        XCTAssertEqual(DisconnectPolicy.response(to: .participantRemoved),
                       .standDown(message: "Removed from the room"))
    }

    // MARK: - Retry (silence is the expensive failure)

    func testServerShutdownRetries() {
        XCTAssertEqual(DisconnectPolicy.response(to: .serverShutdown), .retry)
    }

    func testRoomDeletedRetries() {
        // LiveKit re-creates a room on join, so coming back is well-defined.
        XCTAssertEqual(DisconnectPolicy.response(to: .roomDeleted), .retry)
    }

    func testConnectionLostRetries() {
        // Covers token expiry: tokens are issued with a 4h TTL, and reconnecting fetches a
        // fresh one. An always-on install is guaranteed to hit this.
        XCTAssertEqual(DisconnectPolicy.response(to: .connectionLost("ping timed out")), .retry)
    }

    func testUnknownCauseRetries() {
        // The default has to be "come back". A cause we can't classify — including a new
        // LiveKit error type from an SDK bump — must not leave the room unattended.
        XCTAssertEqual(DisconnectPolicy.response(to: .unknown("something new")), .retry)
    }

    // MARK: - Descriptions

    func testDescriptionsCarryTheDetail() {
        XCTAssertEqual(DisconnectCause.connectionLost("ping timed out").description,
                       "connection lost (ping timed out)")
        XCTAssertEqual(DisconnectCause.unknown("nil error").description,
                       "unrecognized disconnect (nil error)")
    }

    func testEveryCauseDescribesItselfNonEmptily() {
        let causes: [DisconnectCause] = [
            .duplicateIdentity, .participantRemoved, .serverShutdown, .roomDeleted,
            .connectionLost("x"), .unknown("y"),
        ]
        for cause in causes {
            XCTAssertFalse(cause.description.isEmpty, "\(cause) has no description")
        }
    }
}
