import XCTest
@testable import AudioFeederCore

final class LiveKitTokenClientTests: XCTestCase {

    func testRequestBodyMatchesBroadcastContract() {
        let body = LiveKitTokenClient.requestBody(room: "doc-2025-06-30")
        XCTAssertEqual(body["room"], "doc-2025-06-30")
        XCTAssertEqual(body["identity"], "organizer-host")
        XCTAssertEqual(body["role"], "organizer")
    }

    func testOrganizerIdentityConstant() {
        XCTAssertEqual(LiveKitTokenClient.organizerIdentity, "organizer-host")
    }

    func testRequestCarriesTheWriteKeyWhenConfigured() throws {
        let client = LiveKitTokenClient(serverURL: "https://example.com", writeKey: "SECRET123")
        let req = try client.makeRequest(room: "doc-2025-06-30")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Write-Key"), "SECRET123")
    }

    func testRequestOmitsTheWriteKeyHeaderWhenUnset() throws {
        let unset = LiveKitTokenClient(serverURL: "https://example.com")
        XCTAssertNil(try unset.makeRequest(room: "r").value(forHTTPHeaderField: "X-Write-Key"))

        let blank = LiveKitTokenClient(serverURL: "https://example.com", writeKey: "   ")
        XCTAssertNil(try blank.makeRequest(room: "r").value(forHTTPHeaderField: "X-Write-Key"))
    }

    func testWriteKeyDoesNotDisturbTheExistingRequestContract() throws {
        let client = LiveKitTokenClient(serverURL: "https://example.com", writeKey: "SECRET123")
        let req = try client.makeRequest(room: "doc-2025-06-30")

        XCTAssertEqual(req.url?.absoluteString, "https://example.com/api/livekit/token")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let body = try XCTUnwrap(req.httpBody)
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(decoded["room"], "doc-2025-06-30")
        XCTAssertEqual(decoded["identity"], "organizer-host")
        XCTAssertEqual(decoded["role"], "organizer")
    }

    func testTokenDecoding() throws {
        let json = Data(#"{"token":"jwt.abc","serverUrl":"wss://lk.example.com"}"#.utf8)
        let token = try JSONDecoder().decode(LiveKitToken.self, from: json)
        XCTAssertEqual(token.token, "jwt.abc")
        XCTAssertEqual(token.serverUrl, "wss://lk.example.com")
    }
}
