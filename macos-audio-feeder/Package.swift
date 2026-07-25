// swift-tools-version: 5.9
import PackageDescription

// AudioFeeder: a native macOS menu-bar app that feeds one channel of a multichannel
// sound board into the live-translation pipeline by publishing to the session's LiveKit
// room as `organizer-host` (the same identity the browser broadcast page uses).
//
// Layout:
//   - AudioFeederCore  : pure, dependency-light logic (Config, Scheduler, LevelMeter,
//                        ChannelExtractor). Unit-tested. The non-AVFoundation pieces also
//                        build on Linux so the math is testable anywhere.
//   - AudioFeederApp   : the executable app (SwiftUI MenuBarExtra, CoreAudio capture,
//                        LiveKit publishing). macOS-only; depends on the LiveKit Swift SDK.
let package = Package(
    name: "AudioFeeder",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "AudioFeederCore", targets: ["AudioFeederCore"]),
        .executable(name: "AudioFeederApp", targets: ["AudioFeederApp"]),
        // A tiny standalone command-line spike to de-risk the linchpin: does
        // AudioManager manual rendering + mixer.capture(appAudio:) actually publish
        // audio on macOS? Run it, then join the session in a browser to listen.
        .executable(name: "AudioFeederSpike", targets: ["AudioFeederSpike"]),
    ],
    dependencies: [
        // The LiveKit Swift client SDK provides the custom-audio publishing path
        // (AudioManager manual rendering + mixer.capture(appAudio:)).
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.0.7"),
    ],
    targets: [
        .target(
            name: "AudioFeederCore"
        ),
        .executableTarget(
            name: "AudioFeederApp",
            dependencies: [
                "AudioFeederCore",
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
        .executableTarget(
            name: "AudioFeederSpike",
            dependencies: [
                "AudioFeederCore",
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
        .testTarget(
            name: "AudioFeederCoreTests",
            dependencies: ["AudioFeederCore"]
        ),
    ]
)
