import Foundation
import AudioFeederCore

/// Loads/saves `FeederConfig` as JSON under Application Support. Single source of truth for
/// user settings; the UI edits a copy and calls `save`.
final class ConfigStore {
    private let url: URL

    init(appName: String = "AudioFeeder") {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(appName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        } catch {
            Log.controller.error("""
                could not create \(base.path, privacy: .public): \
                \(error.localizedDescription, privacy: .public) — settings will not persist
                """)
        }
        self.url = base.appendingPathComponent("config.json")
    }

    /// Falling back to defaults means a blank write key and no device — indistinguishable on
    /// service morning from a fresh install. Every failure except "no file yet" is logged, so
    /// the reason is recoverable from the system log rather than only from the empty UI.
    func load() -> FeederConfig {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch CocoaError.fileReadNoSuchFile {
            Log.controller.notice("no saved config at \(self.url.path, privacy: .public); using defaults")
            return FeederConfig()
        } catch {
            Log.controller.error("""
                could not read \(self.url.path, privacy: .public): \
                \(error.localizedDescription, privacy: .public) — using defaults
                """)
            return FeederConfig()
        }
        do {
            return try JSONDecoder().decode(FeederConfig.self, from: data)
        } catch {
            Log.controller.error("""
                \(self.url.path, privacy: .public) is not a valid config: \
                \(error.localizedDescription, privacy: .public) — using defaults
                """)
            return FeederConfig()
        }
    }

    func save(_ config: FeederConfig) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try encoder.encode(config).write(to: url, options: .atomic)
        } catch {
            Log.controller.error("""
                could not save \(self.url.path, privacy: .public): \
                \(error.localizedDescription, privacy: .public)
                """)
        }
    }
}
