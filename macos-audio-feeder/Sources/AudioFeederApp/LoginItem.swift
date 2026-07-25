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
            NSLog("LoginItem toggle failed: \(error)")
        }
    }
}
