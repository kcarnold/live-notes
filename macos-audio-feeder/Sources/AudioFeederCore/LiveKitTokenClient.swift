import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What `POST /api/livekit/token` returns: a LiveKit JWT plus the LiveKit ws server URL.
public struct LiveKitToken: Decodable, Sendable, Equatable {
    public let token: String
    public let serverURL: String

    /// The server sends `serverUrl` (see the browser's BroadcastControl.tsx); only the Swift
    /// spelling is normalized here.
    private enum CodingKeys: String, CodingKey {
        case token
        case serverURL = "serverUrl"
    }
}

public enum LiveKitTokenError: Error, CustomStringConvertible {
    case badStatus(Int, String)
    case badServerURL(String)
    case malformedResponse
    case missingFields

    public var description: String {
        switch self {
        case let .badStatus(code, body): return "token endpoint returned HTTP \(code): \(body)"
        case let .badServerURL(url): return "server URL is not a valid URL: \(url)"
        case .malformedResponse: return "token endpoint returned a non-JSON response"
        case .missingFields: return "token response missing token/serverUrl (is LIVEKIT_* configured?)"
        }
    }
}

/// Thin client for the live-notes server's LiveKit token endpoint. Mirrors the request the
/// browser broadcast page makes (see BroadcastControl.tsx): the speaker joins as
/// `organizer-host` with role `organizer` into room == docId.
public struct LiveKitTokenClient: Sendable {
    public static let organizerIdentity = "organizer-host"

    /// Must match WRITE_KEY_HEADER in the server's writeAuth.ts.
    public static let writeKeyHeader = "X-Write-Key"

    public var serverURL: String
    /// Shared key authorizing an organizer (publishing) token. Omitted when nil/blank.
    public var writeKey: String?
    private let session: URLSession

    public init(serverURL: String, writeKey: String? = nil, session: URLSession = .shared) {
        self.serverURL = serverURL
        self.writeKey = writeKey
        self.session = session
    }

    /// Build the request body the server expects.
    public static func requestBody(room: String,
                                   identity: String = organizerIdentity,
                                   role: String = "organizer") -> [String: String] {
        ["room": room, "identity": identity, "role": role]
    }

    /// Build the exact request `fetchToken` sends. Separated so tests can assert on the
    /// headers and body without stubbing the network.
    public func makeRequest(room: String,
                            identity: String = organizerIdentity,
                            role: String = "organizer") throws -> URLRequest {
        let base = serverURL.hasSuffix("/") ? String(serverURL.dropLast()) : serverURL
        guard let url = URL(string: "\(base)/api/livekit/token") else {
            // The likeliest operator mistake in this field is a typo, and `.malformedResponse`
            // would blame the server for it — in the menu-bar status line, on site.
            throw LiveKitTokenError.badServerURL(serverURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = writeKey?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty {
            req.setValue(key, forHTTPHeaderField: Self.writeKeyHeader)
        }
        req.httpBody = try JSONSerialization.data(
            withJSONObject: Self.requestBody(room: room, identity: identity, role: role))
        return req
    }

    public func fetchToken(room: String,
                           identity: String = organizerIdentity,
                           role: String = "organizer") async throws -> LiveKitToken {
        let req = try makeRequest(room: room, identity: identity, role: role)

        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw LiveKitTokenError.badStatus(http.statusCode, body)
        }
        guard let decoded = try? JSONDecoder().decode(LiveKitToken.self, from: data) else {
            throw LiveKitTokenError.malformedResponse
        }
        guard !decoded.token.isEmpty, !decoded.serverURL.isEmpty else {
            throw LiveKitTokenError.missingFields
        }
        return decoded
    }
}
