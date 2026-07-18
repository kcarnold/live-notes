import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What `POST /api/livekit/token` returns: a LiveKit JWT plus the LiveKit ws server URL.
public struct LiveKitToken: Decodable, Sendable, Equatable {
    public let token: String
    public let serverUrl: String
}

public enum LiveKitTokenError: Error, CustomStringConvertible {
    case badStatus(Int, String)
    case malformedResponse
    case missingFields

    public var description: String {
        switch self {
        case let .badStatus(code, body): return "token endpoint returned HTTP \(code): \(body)"
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

    public var serverURL: String
    private let session: URLSession

    public init(serverURL: String, session: URLSession = .shared) {
        self.serverURL = serverURL
        self.session = session
    }

    /// Build the request body the server expects.
    public static func requestBody(room: String,
                                   identity: String = organizerIdentity,
                                   role: String = "organizer") -> [String: String] {
        ["room": room, "identity": identity, "role": role]
    }

    public func fetchToken(room: String,
                           identity: String = organizerIdentity,
                           role: String = "organizer") async throws -> LiveKitToken {
        let base = serverURL.hasSuffix("/") ? String(serverURL.dropLast()) : serverURL
        guard let url = URL(string: "\(base)/api/livekit/token") else {
            throw LiveKitTokenError.malformedResponse
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: Self.requestBody(room: room, identity: identity, role: role))

        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw LiveKitTokenError.badStatus(http.statusCode, body)
        }
        guard let decoded = try? JSONDecoder().decode(LiveKitToken.self, from: data) else {
            throw LiveKitTokenError.malformedResponse
        }
        guard !decoded.token.isEmpty, !decoded.serverUrl.isEmpty else {
            throw LiveKitTokenError.missingFields
        }
        return decoded
    }
}
