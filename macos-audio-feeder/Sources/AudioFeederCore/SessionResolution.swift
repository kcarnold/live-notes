import Foundation

/// What the feeder remembers of the server's answer to "which doc are we in?".
///
/// One value in the core rather than three fields on `AppController`, because these are the
/// rules issue #111 turns on and the app half has no test target. `SessionClient` fetches an
/// answer; this decides how long it may be acted on.
///
/// **The answer expires; it is not merely forgotten.** Forgetting at the end of a run is the
/// obvious rule and it has a hole: the controller only forgets when an `evaluate` lands
/// while off schedule, and a Mac asleep between two Sunday windows never gets one. It would
/// wake up *inside* the next service still holding last week's answer and publish into last
/// week's doc — the exact failure #111 was. An expiry closes that without anything having to
/// notice the run ended.
public struct SessionResolution: Equatable, Sendable {

    /// How long an answer may be acted on before it has to be re-asked. Matches the Proclaim
    /// service's `session_recheck_interval` (`slide_sync_runtime.py`) for the same reason: an
    /// operator's pin has to reach a service that is already on air, not only the next one
    /// to start.
    public static let defaultLifetime: TimeInterval = 60

    public let lifetime: TimeInterval

    /// The last answer we were given, fresh or not. Never computed here — see `SessionClient`.
    ///
    /// Kept past its expiry on purpose: a live pipeline goes on publishing into this room
    /// while a re-ask is in flight. What expiry forbids is *starting* on it.
    public private(set) var docID: String?

    private var freshUntil: Date?

    public init(lifetime: TimeInterval = defaultLifetime) {
        self.lifetime = lifetime
    }

    /// True while `docID` may be acted on: there is an answer, and it has not aged out.
    /// False both when nothing has been asked yet and when the last answer is stale.
    public func isFresh(at now: Date) -> Bool {
        guard docID != nil, let freshUntil else { return false }
        return now < freshUntil
    }

    /// Record the server's answer.
    ///
    /// Returns true when this *moved* the doc — i.e. we had a different answer before. The
    /// caller has to rebuild the pipeline when it did, since a `Publisher` cannot be
    /// retargeted in place. The first answer of a run is not a move.
    @discardableResult
    public mutating func record(docID newDocID: String, at now: Date) -> Bool {
        let moved = docID != nil && docID != newDocID
        docID = newDocID
        freshUntil = now.addingTimeInterval(lifetime)
        return moved
    }

    /// A re-check failed while a pipeline was publishing. Keep the answer and try again after
    /// another interval: a stale doc answer costs a minute, dropping the pipeline costs the
    /// broadcast.
    public mutating func extendFreshness(from now: Date) {
        guard docID != nil else { return }
        freshUntil = now.addingTimeInterval(lifetime)
    }

    /// Drop the answer outright, rather than letting it age out: the run ended, or the
    /// question itself changed (a different server or override), so what we hold is no longer
    /// an answer to what we are now asking.
    public mutating func forget() {
        docID = nil
        freshUntil = nil
    }
}
