# macOS Audio Feeder

A native macOS menu-bar app that feeds **one channel of a multichannel sound board** into
the live-notes translation pipeline — automatically, on a schedule. It publishes to the
session's LiveKit room as `organizer-host`, the **same identity the browser broadcast page
uses** (`src/BroadcastControl.tsx`), so there are **no server changes** and the browser
broadcast still works as an alternative input. (LiveKit allows one participant per identity,
so the app and the browser page are mutually exclusive — use one or the other.)

See the design notes for the full rationale (TCC/permissions, why pure Swift, the
custom-audio publishing path).

## Requirements

- macOS 14+
- Xcode 15+ / a recent Swift toolchain
- The live-notes server must have LiveKit configured (`LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`), otherwise `/api/livekit/token` returns 503.

## The spike — run this first

The whole design hinges on one unverified assumption: that the LiveKit Swift SDK's
custom-audio path (`AudioManager.setManualRenderingMode(true)` +
`AudioManager.shared.mixer.capture(appAudio:)`) actually publishes audio on macOS. The
`AudioFeederSpike` executable proves it end-to-end by publishing a sine tone — no sound
board required.

```bash
cd macos-audio-feeder

# Publish a 440 Hz tone into today's session on your dev server:
swift run AudioFeederSpike --server-url https://dev8.kenarnold.org

# …or target a specific doc / pitch:
swift run AudioFeederSpike --server-url https://dev8.kenarnold.org --doc doc-2025-06-30 --freq 660
```

Then open that session in a browser **as a listener** (not the broadcast page) and confirm:

1. `organizer-host` shows up as a participant.
2. A translator bot spins up and you can hear/See the tone being carried.
3. Press **Ctrl-C** in the terminal to stop; `organizer-host` leaves and the browser
   broadcast page becomes usable again.

The first run will prompt for **Microphone** permission (manual rendering still counts as
audio I/O). Grant it.

### If the spike's API names don't resolve

`setManualRenderingMode` / `mixer.capture(appAudio:)` come from the SDK's `Docs/audio.md`.
If they don't match the installed SDK version, reconcile them in
`Sources/AudioFeederSpike/main.swift` (the call site is marked `<<< API UNDER TEST >>>`).
If the custom-audio path turns out not to work on macOS at all, the fallback is to expose
the desired channel as its own input device via a macOS **Aggregate Device** and use the
SDK's normal device capture — still pure Swift.

## Tests

The pure logic (scheduler, level/RMS, channel extraction, config, token contract) is unit
tested and has no audio/LiveKit dependencies:

```bash
swift test
```

## Project layout

```
macos-audio-feeder/
  Package.swift
  Sources/
    AudioFeederCore/     # pure, tested: Config, Scheduler, LevelMeter, ChannelExtractor,
                         #               ToneGenerator, LiveKitTokenClient
    AudioFeederSpike/    # standalone tone-publishing spike (run this first)
    AudioFeederApp/      # the menu-bar app (capture + publish + UI)
  Tests/
    AudioFeederCoreTests/
```

## The app

```bash
swift build              # compiles AudioFeederApp (and the core + spike)
swift run AudioFeederApp # runs from the SwiftPM build for development
```

> **Packaging caveat:** a SwiftPM executable is fine for development, but the menu-bar-only
> behavior (`LSUIElement`), the microphone permission string, login-item registration
> (`SMAppService`), and signing/notarization all require a real `.app` **bundle**. The
> `Packaging/Info.plist` and `Packaging/AudioFeeder.entitlements` here are ready for an
> Xcode app target (or a bundling build script) — that step is still to do.

## Status

- [x] Pure core + unit tests (scheduler, level/RMS, channel pick, config, token contract)
- [x] Spike (validate custom-audio publishing on macOS) — **ready to run**
- [x] Capture (`AudioCapture`: AVAudioEngine bound to device by UID, channel extraction)
- [x] Device enumeration + hot-plug (`DeviceMonitor`, CoreAudio)
- [x] LiveKit publisher (`Publisher`: token fetch, manual rendering + mixer.capture,
      retry/backoff, identity release on stop)
- [x] Orchestration (`AppController`: schedule eval, manual override, waiting-for-device)
- [x] MenuBarExtra UI + settings + login-item toggle
- [ ] Package as a signed/notarized `.app` bundle (Info.plist/entitlements provided)
- [ ] (Optional) WKWebView transcript/translations pane
- [ ] Verify on a Mac: spike first, then end-to-end with a real board
