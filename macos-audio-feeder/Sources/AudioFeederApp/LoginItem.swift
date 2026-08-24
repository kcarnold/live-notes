import Foundation
import ServiceManagement

/// Registers the app as a background **login item** so it runs as a de-facto service on a
/// (auto-)logged-in Mac. Mic capture requires a user session, so this is the correct
/// "service" form on macOS — see the design notes.
enum LoginItem {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            } else {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                }
            }
        } catch {
            // Not NSLog: a failed registration is exactly the thing that stops an unattended
            // Mac coming back after a reboot, and it has to be visible to the `log stream`
            // predicate in README.md like everything else.
            Log.controller.error("""
                login item \(enabled ? "register" : "unregister", privacy: .public) failed: \
                \(error.localizedDescription, privacy: .public)
                """)
        }
    }
}
