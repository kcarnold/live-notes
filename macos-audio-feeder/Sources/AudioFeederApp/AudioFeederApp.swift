import SwiftUI

/// Menu-bar-only app (no Dock icon — set `LSUIElement` in the bundle's Info.plist when
/// packaging). The window-style MenuBarExtra hosts the level meter, status, and controls.
@main
struct AudioFeederApp: App {
    @StateObject private var controller = AppController()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(controller: controller)
                .frame(width: 340)
        } label: {
            // SF Symbol reflects whether we're live.
            Image(systemName: controller.isPublishing ? "dot.radiowaves.left.and.right" : "waveform")
        }
        .menuBarExtraStyle(.window)
    }
}

extension AppController {
    /// Convenience for the menu-bar glyph.
    var isPublishing: Bool { if case .publishing = status { return true } else { return false } }
}
