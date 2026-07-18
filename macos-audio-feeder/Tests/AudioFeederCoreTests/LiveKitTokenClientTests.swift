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

    func testTokenDecoding() throws {
        let json = Data(#"{"token":"jwt.abc","serverUrl":"wss://lk.example.com"}"#.utf8)
        let token = try JSONDecoder().decode(LiveKitToken.self, from: json)
        XCTAssertEqual(token.token, "jwt.abc")
        XCTAssertEqual(token.serverUrl, "wss://lk.example.com")
    }
}
