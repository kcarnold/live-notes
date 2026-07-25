import Foundation
import AudioFeederCore

/// Loads/saves `FeederConfig` as JSON under Application Support. Single source of truth for
/// user settings; the UI edits a copy and calls `save`.
final class ConfigStore {
    private let url: URL

    init(appName: String = "AudioFeeder") {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(appName, isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        self.url = base.appendingPathComponent("config.json")
    }

    func load() -> FeederConfig {
        guard let data = try? Data(contentsOf: url),
              let cfg = try? JSONDecoder().decode(FeederConfig.self, from: data) else {
            return FeederConfig()
        }
        return cfg
    }

    func save(_ config: FeederConfig) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(config) {
            try? data.write(to: url, options: .atomic)
        }
    }
}
