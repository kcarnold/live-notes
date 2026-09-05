import XCTest
@testable import AudioFeederCore

/// The contract with `/api/session/current` (`sessionRoutes.ts`), and the precedence the
/// browser uses (`src/getDocId.ts`). This app's whole reason for asking is #111: two parties
/// each computing "today's doc" and disagreeing, invisibly, for a whole service.
final class SessionClientTests: XCTestCase {

    func testRequestMatchesTheEndpointContract() throws {
        let req = try SessionClient(serverURL: "https://example.com").makeRequest()
        XCTAssertEqual(req.url?.absoluteString, "https://example.com/api/session/current")
        XCTAssertEqual(req.httpMethod, "GET")
        // The answer decides which doc a whole service writes to and changes the moment
        // someone pins one; a cached copy is a feeder left in the doc they moved off.
        XCTAssertEqual(req.cachePolicy, .reloadIgnoringLocalCacheData)
        // Short on purpose: a hang here is an unattended feeder sitting on "Finding the
        // current session…" instead of retrying. See the comment in `makeRequest`.
        XCTAssertEqual(req.timeoutInterval, 10)
    }

    func testRequestToleratesATrailingSlashOnTheServerURL() throws {
        let req = try SessionClient(serverURL: "https://example.com/").makeRequest()
        XCTAssertEqual(req.url?.absoluteString, "https://example.com/api/session/current")
    }

    /// Reading the current session is open — no write key. Asserted so nobody "fixes" this
    /// into a gated call and locks an unattended feeder out of the answer.
    func testRequestCarriesNoWriteKey() throws {
        let req = try SessionClient(serverURL: "https://example.com").makeRequest()
        XCTAssertNil(req.value(forHTTPHeaderField: LiveKitTokenClient.writeKeyHeader))
    }

    func testDecodesTheServersAnswer() throws {
        let json = Data(#"""
        {"docId":"doc-2026-08-30","source":"pin","since":"2026-08-30T14:00:00.000Z",
         "setBy":"status-page","expiresAt":"2026-08-31T08:00:00.000Z"}
        """#.utf8)
        let session = try SessionClient.decode(json)
        XCTAssertEqual(session.docId, "doc-2026-08-30")
        XCTAssertEqual(session.source, "pin")
        XCTAssertEqual(session.setBy, "status-page")
    }

    /// `source: 'date'` carries nulls for the rest. Decoding must survive them: that is the
    /// ordinary Sunday answer, not an edge case.
    func testDecodesADateSourcedAnswerWithNulls() throws {
        let json = Data(#"{"docId":"doc-2026-08-30","source":"date","since":null,"setBy":null,"expiresAt":null}"#.utf8)
        let session = try SessionClient.decode(json)
        XCTAssertEqual(session.docId, "doc-2026-08-30")
        XCTAssertNil(session.setBy)
    }

    /// A reverse proxy's HTML error page arrives with a 200 and is not a session. In the
    /// Proclaim service this raised `ValueError` outside the caught tuple and took the
    /// service down; here it must be an ordinary error the retry path already handles.
    func testAnHTMLErrorPageIsAnError() {
        let html = Data("<!doctype html><html><body>502 Bad Gateway</body></html>".utf8)
        XCTAssertThrowsError(try SessionClient.decode(html)) { error in
            XCTAssertEqual(error as? SessionError, .malformedResponse)
        }
    }

    /// A well-formed answer that names no doc means nothing, and must not become a room name.
    func testAnAnswerWithoutADocIDIsAnError() {
        XCTAssertThrowsError(try SessionClient.decode(Data(#"{"source":"date"}"#.utf8))) { error in
            XCTAssertEqual(error as? SessionError, .malformedResponse)
        }
        XCTAssertThrowsError(try SessionClient.decode(Data(#"{"docId":"  "}"#.utf8))) { error in
            XCTAssertEqual(error as? SessionError, .missingDocID)
        }
    }

    // MARK: - Precedence

    /// The override is the escape hatch for when the server's answer is wrong, so it cannot
    /// stand behind a request to the server to take effect. An unresolvable URL proves no
    /// request was made: reaching the network at all would throw instead.
    func testOverrideWinsWithoutARoundTrip() async throws {
        let client = SessionClient(serverURL: "https://this-host-does-not-exist.invalid")
        let resolved = try await client.resolve(override: "doc-rehearsal")
        XCTAssertEqual(resolved.docID, "doc-rehearsal")
        XCTAssertEqual(resolved.origin, "configured override")
    }

    /// An emptied settings field leaves whitespace behind. That means "ask the server", and
    /// must not become a room named `"   "`.
    func testBlankOverrideIsNotAnOverride() {
        XCTAssertNil(SessionClient.normalizedOverride(nil))
        XCTAssertNil(SessionClient.normalizedOverride(""))
        XCTAssertNil(SessionClient.normalizedOverride("   "))
        XCTAssertEqual(SessionClient.normalizedOverride("  doc-x  "), "doc-x")
    }

    /// The log line is the deliverable here: #111 stayed invisible for a whole service
    /// because the only line anyone read said which doc the service *meant* to use.
    func testOriginReadsAsASentence() {
        XCTAssertEqual(SessionClient.origin(of: CurrentSession(docId: "d", source: "pin", setBy: "status-page")),
                       "pin set by status-page")
        XCTAssertEqual(SessionClient.origin(of: CurrentSession(docId: "d", source: "proposal", setBy: "proclaim-service")),
                       "proposal from proclaim-service")
        XCTAssertEqual(SessionClient.origin(of: CurrentSession(docId: "d", source: "date")), "the date")
        // A source this build has never heard of is reported, not refused: an unattended
        // feeder must not decline to start because the server learned a new word.
        XCTAssertEqual(SessionClient.origin(of: CurrentSession(docId: "d", source: "handoff")), "handoff")
    }
}
