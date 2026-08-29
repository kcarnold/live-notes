import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Which Y-Sweet doc / LiveKit room the whole service is using — asked, never computed.
///
/// The feeder used to derive `doc-YYYY-MM-DD` from this Mac's clock. Issue #111 is what
/// happens when two parties each hold their own copy of that formula: the Proclaim service
/// wrote a whole service's slides into last week's doc while logging this week's. The fix
/// was to make the current session a fact the server owns and everyone reads
/// (`docs/CURRENT_SESSION.md`) — and the follow-up made an operator's pin reach a service
/// that is *already on air*, because a wrong doc has to be fixable from a pew, mid-service.
///
/// This app was the party that never got either half. Its room name came from its own
/// clock, so a pin moved the notes, the slides and every listener to another doc while the
/// microphone kept publishing into the old one — splitting the service instead of moving
/// it. It now reads the same answer as everyone else, and re-reads it while running.
///
/// There is deliberately **no local date fallback**, matching `src/getDocId.ts`. It costs
/// nothing here: the same server that answers this also issues the LiveKit token, so if
/// this request can't get through, the run couldn't have started anyway. Guessing would
/// only re-create #111's real defect — a component acting on its own private answer and
/// reporting it as fact.

/// The server's answer — `GET /api/session/current`. Mirrors `CurrentSession` in
/// `src/sessionCurrent.ts`; only the fields worth logging here are decoded.
public struct CurrentSession: Decodable, Sendable, Equatable {
    public let docId: String
    /// `pin` | `proposal` | `date`. Kept as a plain string rather than an enum on purpose:
    /// an unattended feeder must not refuse to start because the server learned a fourth
    /// word for where an answer came from.
    public let source: String?
    /// Free-text label for who set it (`status-page`, `proclaim-service`), when anyone did.
    public let setBy: String?

    public init(docId: String, source: String? = nil, setBy: String? = nil) {
        self.docId = docId
        self.source = source
        self.setBy = setBy
    }
}

public enum SessionError: Error, Equatable, CustomStringConvertible {
    case badStatus(Int, String)
    case malformedResponse
    case missingDocID

    public var description: String {
        switch self {
        case let .badStatus(code, body): return "session endpoint returned HTTP \(code): \(body)"
        case .malformedResponse: return "session endpoint returned a non-JSON response"
        case .missingDocID: return "session response did not name a docId"
        }
    }
}

/// The doc to use, and where it came from — the second half being what makes an unattended
/// log readable. #111 stayed invisible for a whole service because the one line anybody
/// read said which doc the service *meant* to use.
public struct ResolvedSession: Sendable, Equatable {
    public let docID: String
    /// Log-ready provenance: `configured override`, `pin set by status-page`, `date`.
    public let origin: String

    public init(docID: String, origin: String) {
        self.docID = docID
        self.origin = origin
    }
}

/// Client for the server-owned current session. Server side: `sessionRoutes.ts`.
///
/// Reading is open — no write key. It is on the critical path of every page load and
/// stands between a viewer and the service, so it deliberately requires nothing.
public struct SessionClient: Sendable {
    public var serverURL: String
    private let session: URLSession

    public init(serverURL: String, session: URLSession = .shared) {
        self.serverURL = serverURL
        self.session = session
    }

    /// Build the exact request `fetchCurrent` sends. Separated so tests can assert on it
    /// without stubbing the network.
    public func makeRequest() throws -> URLRequest {
        let base = serverURL.hasSuffix("/") ? String(serverURL.dropLast()) : serverURL
        guard let url = URL(string: "\(base)/api/session/current") else {
            throw SessionError.malformedResponse
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        // The server sends `Cache-Control: no-store`; say so from this end too. A stale
        // answer here is a feeder publishing into the doc an operator just moved off.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        // Well under URLSession's 60s default. This is a few bytes of JSON from the same
        // host that has to answer a token request seconds later; a minute of hanging on it
        // is a minute of an unattended feeder showing "Finding the current session…" and
        // not retrying. Failing fast feeds the caller's existing backoff.
        req.timeoutInterval = 10
        return req
    }

    /// Decode an answer, refusing the two shapes that are *not* a session.
    ///
    /// Both are real: a reverse proxy's HTML error page arrives with a 200 and fails to
    /// parse, and a partial answer with no `docId` decodes fine and means nothing. In the
    /// Proclaim service these two escaped the reconnect loop as `ValueError`/`KeyError`
    /// and took the service down; here they are one error the retry path already handles.
    public static func decode(_ data: Data) throws -> CurrentSession {
        guard let decoded = try? JSONDecoder().decode(CurrentSession.self, from: data) else {
            throw SessionError.malformedResponse
        }
        guard !decoded.docId.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw SessionError.missingDocID
        }
        return decoded
    }

    /// How the server's answer reads in a log line.
    public static func origin(of session: CurrentSession) -> String {
        switch session.source {
        case "pin": return "pin set by \(session.setBy ?? "someone")"
        case "proposal": return "proposal from \(session.setBy ?? "the Proclaim service")"
        case "date": return "the date"
        case let other?: return other
        case nil: return "the server"
        }
    }

    public func fetchCurrent() async throws -> CurrentSession {
        let (data, response) = try await session.data(for: makeRequest())
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw SessionError.badStatus(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return try Self.decode(data)
    }

    /// The doc to publish into, applying the same precedence the browser uses
    /// (`src/getDocId.ts`): an explicit override wins outright and without a round trip —
    /// it is the escape hatch for when the server's answer is wrong, so it must not be
    /// standing behind the server to take effect. Otherwise, the server's answer or an
    /// error. Never a date computed here.
    public func resolve(override: String?) async throws -> ResolvedSession {
        if let override = Self.normalizedOverride(override) {
            return ResolvedSession(docID: override, origin: "configured override")
        }
        let current = try await fetchCurrent()
        return ResolvedSession(docID: current.docId, origin: Self.origin(of: current))
    }

    /// An override is only an override if it says something. Blank and whitespace-only
    /// mean "ask the server", which is what an emptied settings field leaves behind.
    public static func normalizedOverride(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
