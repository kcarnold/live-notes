import Foundation
import os

/// Unified-logging channels for the app.
///
/// Everything goes through `os.Logger` rather than `print`/`NSLog` so that a headless,
/// unattended run is still observable: the logs land in the system log store and can be
/// streamed live or dumped after the fact without a debugger attached. See the "Watching the
/// logs" section of README.md for the `log stream` / `log show` invocations.
///
/// Why this exists: the venue failure on 2026-07-26 was diagnosable in one line, but the
/// thrown `Room.connect` error only ever reached `AppController.status`, which is rendered
/// exclusively in the menu-bar popover — and the popover was itself misbehaving. The one
/// fact that identified the bug was unobservable on site. See NOTEBOOK.md.
enum Log {
    /// Matches the bundle identifier so `--predicate 'subsystem == "org.kenarnold.audio-feeder"'`
    /// picks up every channel below.
    static let subsystem = "org.kenarnold.audio-feeder"

    /// Schedule evaluation and the capture→publish lifecycle.
    static let controller = Logger(subsystem: subsystem, category: "controller")
    /// CoreAudio device binding, negotiated formats, engine start/stop.
    static let capture = Logger(subsystem: subsystem, category: "capture")
    /// Token fetch, LiveKit room connect, publish state.
    static let publisher = Logger(subsystem: subsystem, category: "publisher")
    /// Device enumeration and hot-plug notifications.
    static let devices = Logger(subsystem: subsystem, category: "devices")
}
