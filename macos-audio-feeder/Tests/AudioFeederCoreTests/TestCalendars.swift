import Foundation

/// The suite's UTC calendar, built once and shared.
///
/// Replaces four identical copies of the same computed property, each of which rebuilt a
/// `Calendar` on every access and force-unwrapped `TimeZone(identifier: "UTC")`. `.gmt` is
/// non-optional, so there is nothing left to unwrap.
let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    return calendar
}()
