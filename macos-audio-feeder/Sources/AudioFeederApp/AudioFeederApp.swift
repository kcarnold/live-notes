import SwiftUI
import AppKit
import Combine

/// Menu-bar-only app. We drive the menu bar with an `NSStatusItem` + `NSPopover`
/// (via the AppDelegate) instead of SwiftUI's `MenuBarExtra`, because a `MenuBarExtra(.window)`
/// panel auto-dismisses the moment any child menu/sheet steals key focus — which is exactly
/// what made the device `Picker` flicker away. An `NSPopover` behaves like Dropbox's menu:
/// the container stays put while a Picker's dropdown floats over it.
///
/// The only SwiftUI `Scene` is the standard `Settings` window (opened from the popover via
/// `SettingsLink`), which hosts the existing `ConfigView`. Settings controls — including the
/// device Picker — live in a real window, so they work normally.
@main
struct AudioFeederApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            ConfigView(controller: appDelegate.controller)
        }
    }
}

/// Owns the status-bar item and the popover. No Dock icon (`.accessory`).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller = AppController()

    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var statusObserver: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu-bar only — no Dock icon, no app menu. (At package time `LSUIElement` in the
        // bundle's Info.plist does the same thing; this covers the SwiftPM dev run too.)
        NSApp.setActivationPolicy(.accessory)

        popover.behavior = .transient        // closes when you click outside, like a menu
        popover.animates = true

        // NSPopover sizes itself from its content view controller's `preferredContentSize`.
        // NSHostingController only publishes SwiftUI's ideal size there if you ask for it —
        // the default `sizingOptions` is empty. Without this the popover keeps whatever
        // frame it first got while the SwiftUI content grows and shrinks underneath, which
        // is what produced the blank bands above and below the content (worst when a long
        // error string wrapped the status line onto several lines).
        let hosting = NSHostingController(rootView: MenuContentView(controller: controller))
        hosting.sizingOptions = [.preferredContentSize]
        popover.contentViewController = hosting

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.action = #selector(togglePopover(_:))
        item.button?.target = self
        statusItem = item
        updateStatusIcon()

        // Keep the menu-bar glyph in sync with publishing state.
        statusObserver = controller.$status.sink { [weak self] _ in
            MainActor.assumeIsolated { self?.updateStatusIcon() }
        }
    }

    private func updateStatusIcon() {
        let symbol = controller.isPublishing ? "dot.radiowaves.left.and.right" : "waveform"
        statusItem?.button?.image = NSImage(systemSymbolName: symbol,
                                            accessibilityDescription: "Audio Feeder")
    }

    @objc private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            // Let the popover take key focus so any controls inside behave normally.
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}

extension AppController {
    /// Convenience for the menu-bar glyph.
    var isPublishing: Bool { if case .publishing = status { return true } else { return false } }
}
