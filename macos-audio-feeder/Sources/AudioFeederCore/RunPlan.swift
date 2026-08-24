import Foundation

/// What the feeder is doing and what happens to it next, as one sentence.
///
/// The popover said what the feeder was doing *now* ("Idle") but never whether anything would
/// change that: an install whose schedule is switched off sits at "Idle" indefinitely and looks
/// exactly like one that is five minutes from going live. So every state that decides whether we
/// go on air gets a sentence, built here — pure, and covered by `swift test` with no Xcode and
/// no UI. (Same rule the settings window's `Schedule.summary` follows, and the same reason.)
///
/// Every sentence answers the one question an operator has: *what happens next, and when.*
public struct RunPlan: Equatable, Sendable {
    /// Whether the feeder should be on air right now.
    public let isOn: Bool
    /// Whether a manual hold — not the schedule — is the reason for `isOn`.
    public let isHeld: Bool
    /// The sentence. Always names a clock time when there is one to name.
    public let summary: String
    /// Nothing will start the feeder on its own. Worth a colour: it is the state an unattended
    /// install can be left in by accident, and the one nothing resolves on its own.
    public let isInert: Bool

    public static func evaluate(now: Date,
                                schedule: Schedule,
                                hold: RunHold?,
                                calendar: Calendar = .current) -> RunPlan {
        let live = hold.flatMap { $0.isLive(at: now) ? $0 : nil }
        let isOn = Scheduler.shouldRun(now: now, schedule: schedule, hold: live, calendar: calendar)
        let isInert = !schedule.willEverRun

        return RunPlan(isOn: isOn,
                       isHeld: live != nil,
                       summary: sentence(now: now, schedule: schedule, hold: live,
                                         isOn: isOn, calendar: calendar),
                       isInert: isInert)
    }

    private static func sentence(now: Date,
                                 schedule: Schedule,
                                 hold: RunHold?,
                                 isOn: Bool,
                                 calendar: Calendar) -> String {
        if isOn {
            // A capped hold is the one case with no scheduled stop to quote, so it names its own
            // end. Otherwise the run ends where the schedule ends it — which is true whether the
            // hold started it early or the schedule did, because the hold expires at the start
            // edge and hands over mid-run.
            let end: Date? = (hold?.isCapped == true)
                ? hold?.endsAt
                : schedule.nextStop(after: now, calendar: calendar)
            guard let end else { return "Running — no scheduled stop." }
            let tail = "runs until \(hhmm(end, calendar))."
            return hold != nil ? "Started early — \(tail)" : tail.capitalizedFirst
        }

        // Off, and the schedule can't change that: say which of the several identical-looking
        // ways it is inert, in the words the settings window already uses.
        guard schedule.willEverRun,
              let start = schedule.nextStart(after: now, calendar: calendar) else {
            return schedule.summary
        }

        let day = calendar.component(.weekday, from: start)
        let window = "\(Schedule.formatHHMM(schedule.startMinute))–\(Schedule.formatHHMM(schedule.stopMinute))"
        let tail = schedule.startMinute < schedule.stopMinute ? "" : " the next day"
        let next = "next run \(Schedule.weekdaySymbol(day)) \(window)\(tail)."
        return hold != nil ? "Stopped early — \(next)" : next.capitalizedFirst
    }

    /// A `Date` as the wall-clock `HH:mm` an operator sees on the wall.
    private static func hhmm(_ date: Date, _ calendar: Calendar) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return Schedule.formatHHMM((c.hour ?? 0) * 60 + (c.minute ?? 0))
    }
}

private extension String {
    /// Uppercases the first character only — these sentences are assembled from a fragment that
    /// reads either mid-sentence ("Started early — runs until…") or as the whole thing.
    var capitalizedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
