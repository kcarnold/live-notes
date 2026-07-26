// swift-tools-version: 5.9
import PackageDescription

// AudioFeederCore: the pure, dependency-free logic behind the macOS Audio Feeder app
// (Config, Scheduler, LevelMeter, ChannelExtractor, ToneGenerator, LiveKitTokenClient).
//
// This package deliberately contains ONLY the core library and its tests. The app itself
// (`AudioFeederApp` — SwiftUI menu bar, CoreAudio capture, LiveKit publishing) is built by
// the Xcode project generated from `project.yml`, because producing a real `.app` bundle
// requires app-target machinery SwiftPM doesn't have: embedding the LiveKit SDK's binary
// XCFrameworks, Info.plist processing, entitlements, and signing/notarization.
//
// Keeping the core here means `swift test` stays fast, needs no Xcode, and (for the
// non-AVFoundation pieces) runs on Linux too. See README.md.
let package = Package(
    name: "AudioFeederCore",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "AudioFeederCore", targets: ["AudioFeederCore"]),
    ],
    targets: [
        .target(
            name: "AudioFeederCore"
        ),
        .testTarget(
            name: "AudioFeederCoreTests",
            dependencies: ["AudioFeederCore"]
        ),
    ]
)
