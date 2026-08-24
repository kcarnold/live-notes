import Foundation

/// A manual answer that outranks the schedule for one run's worth of time, and then expires.
///
/// This replaced a persisted three-way mode (`Schedule | Always on | Always off`), which gave
/// permanent answers to a temporary question: the actual need at the sound board is to start a
/// few minutes early or end a service early, not to switch the schedule off. A hold ends at
/// **the schedule's next edge of the kind it preempted** — *start now* ends at the next
/// scheduled start (after which the schedule is on anyway and carries the run to its normal
/// stop), *stop now* ends at the next scheduled stop (the end of the run it cut short).
///
/// Two properties are worth keeping if this is ever rewritten:
///
/// - **`endsAt` is resolved up front**, so `Scheduler.shouldRun` is stateless. The tempting
///   alternative — no end time, expire once the schedule "agrees" with the hold — resurrects:
///   a hold-on at 09:40 against a 10:00–11:00 window is satisfied at 10:00, and then at 11:30
///   the schedule disagrees again and the hold switches the feeder back on. Making that safe
///   would rest correctness on the controller's 15s tick having fired.
/// - **The cap is anchored to `setAt`**, not to the recompute, so editing the schedule under a
///   live hold can never stretch it past four hours from the button press.
public struct RunHold: Equatable, Sendable {

    /// Ceiling on a hold, regardless of what the schedule does.
    ///
    /// Without it, "start now" pressed on a Wednesday afternoon runs until Sunday's window: the
    /// machine is unattended, publishing evicts whoever else holds the room, and it costs money.
    /// Four hours covers setup plus a long service.
    public static let maxDuration: TimeInterval = 4 * 60 * 60

    public let shouldPublish: Bool
    public let setAt: Date
    public let endsAt: Date
    /// True when `maxDuration` ended the hold rather than a scheduled edge. The decision doesn't
    /// care, but the UI does: it changes which time the sentence should name.
    public let isCapped: Bool

    public init(shouldPublish: Bool, setAt: Date, endsAt: Date, isCapped: Bool) {
        self.shouldPublish = shouldPublish
        self.setAt = setAt
        self.endsAt = endsAt
        self.isCapped = isCapped
    }

    /// Hold `shouldPublish` from `now` until the schedule's next edge of the kind it preempts, or
    /// `maxDuration` after `now`, whichever comes first.
    public static func starting(_ shouldPublish: Bool,
                                at now: Date,
                                schedule: Schedule,
                                calendar: Calendar = .current) -> RunHold {
        let capEnd = now.addingTimeInterval(maxDuration)
        let edge = shouldPublish
            ? schedule.nextStart(after: now, calendar: calendar)
            : schedule.nextStop(after: now, calendar: calendar)
        if let edge, edge <= capEnd {
            return RunHold(shouldPublish: shouldPublish, setAt: now, endsAt: edge, isCapped: false)
        }
        return RunHold(shouldPublish: shouldPublish, setAt: now, endsAt: capEnd, isCapped: true)
    }

    /// The same rule re-applied from `setAt` against an edited schedule.
    ///
    /// Needed so "stop now" keeps meaning *end this run* after the run's definition changes:
    /// stop at 11:15 in a 10:00–12:00 window, then extend the stop to 14:00, and a frozen
    /// `endsAt` would put the feeder back on air at 12:00 — partway through a run the operator
    /// had just opted out of.
    public func recomputed(for schedule: Schedule, calendar: Calendar = .current) -> RunHold {
        RunHold.starting(shouldPublish, at: setAt, schedule: schedule, calendar: calendar)
    }

    /// Whether this hold has anything to say at `now`.
    ///
    /// A hold is an interval, not a flag: it covers `[setAt, endsAt)`. Bounding the near end
    /// matters less in production — nothing evaluates a hold before it was pressed — than as a
    /// guard against a hold answering for instants it was never asked about, which is exactly
    /// how a test or a backwards clock step would find a wrong answer.
    public func isLive(at now: Date) -> Bool { now >= setAt && now < endsAt }
}
