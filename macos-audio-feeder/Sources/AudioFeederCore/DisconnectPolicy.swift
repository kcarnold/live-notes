import Foundation

/// Why an *established* publish session ended.
///
/// Deliberately expressed in the feeder's own terms rather than the LiveKit SDK's, so the
/// policy below lives in the dependency-free core and stays unit-testable. The mapping from
/// `LiveKitError` lives next to the SDK, in `Publisher`.
public enum DisconnectCause: Equatable, Sendable {
    /// Someone else claimed our identity. LiveKit permits one participant per identity and
    /// the newcomer wins, so this is what opening `src/BroadcastControl.tsx` does to a
    /// running feeder: both join as `organizer-host`.
    case duplicateIdentity
    /// An operator removed this participant from the room.
    case participantRemoved
    /// The server went away — shutdown or restart.
    case serverShutdown
    /// The room was deleted server-side.
    case roomDeleted
    /// The connection died and the SDK could not recover it: network loss it failed to
    /// resume, a ping timeout, or a token that reached its TTL (they are issued with
    /// `ttl: '4h'` — see `server.ts`).
    case connectionLost(String)
    /// Not classifiable from what the SDK reported.
    case unknown(String)
}

extension DisconnectCause: CustomStringConvertible {
    /// Short and human-readable, for the log line and the status text.
    public var description: String {
        switch self {
        case .duplicateIdentity: return "another participant took the organizer-host identity"
        case .participantRemoved: return "removed from the room"
        case .serverShutdown: return "server shut down"
        case .roomDeleted: return "room deleted"
        case let .connectionLost(detail): return "connection lost (\(detail))"
        case let .unknown(detail): return "unrecognized disconnect (\(detail))"
        }
    }
}

/// What the feeder should do about a `DisconnectCause`.
public enum DisconnectResponse: Equatable, Sendable {
    /// Tear the pipeline down and connect again after the caller's backoff.
    case retry
    /// Stop, and stay stopped until a person intervenes. `message` is what to show them.
    case standDown(message: String)
}

/// The one decision that matters after an unexpected disconnect: come back, or stay down?
///
/// The default is `retry`. For a feeder whose whole point is running unattended, the
/// expensive failure is silence — a service happening in a room we are no longer in — so
/// anything not positively identified as "a second actor deliberately took our place" is
/// treated as recoverable and retried with backoff. Reconnecting also re-fetches a token,
/// which is what makes the 4h TTL survivable.
///
/// The two exceptions are the cases where retrying would fight a human:
///
/// - `duplicateIdentity` — the app and the browser broadcast page share the literal identity
///   `organizer-host`, and that shared identity is what *enforces* "only one broadcaster"
///   (see `ORGANIZER_PREFIX` in `live-audio/translation-session-manager.ts`). Reconnecting
///   would evict whoever just evicted us, who would evict us straight back.
/// - `participantRemoved` — nothing in live-notes removes participants, so this only happens
///   when someone reaches for the LiveKit dashboard or CLI to kick the feeder. Retrying
///   would take away the only remote stop button they have.
///
/// Both are recoverable from the menu bar ("Reconnect anyway"), and neither survives the end
/// of the run window — the next scheduled window starts clean.
public enum DisconnectPolicy {

    public static func response(to cause: DisconnectCause) -> DisconnectResponse {
        switch cause {
        case .duplicateIdentity:
            return .standDown(message: "Taken over by the broadcast page")
        case .participantRemoved:
            return .standDown(message: "Removed from the room")
        // Listed rather than defaulted: a new cause should not silently inherit a policy.
        case .serverShutdown, .roomDeleted, .connectionLost, .unknown:
            return .retry
        }
    }
}
