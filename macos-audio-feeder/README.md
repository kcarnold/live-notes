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

## Custom-audio publishing

The design's linchpin — the LiveKit Swift SDK's custom-audio path
(`AudioManager.setManualRenderingMode(true)` + `AudioManager.shared.mixer.capture(appAudio:)`)
actually publishing audio on macOS — has been verified end-to-end on real hardware with a
real sound board. `AudioFeederApp`'s `Publisher` (`Sources/AudioFeederApp/Publisher.swift`)
uses that path in production. If a future LiveKit SDK upgrade breaks those API names (see the
SDK's `Docs/audio.md`), the fallback is a macOS Aggregate Device exposing the desired channel
as its own input, captured via the SDK's normal device-capture path — still pure Swift; see
the note in `Publisher.swift`.

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
    AudioFeederApp/      # the menu-bar app (capture + publish + UI)
  Tests/
    AudioFeederCoreTests/
```

## The app

```bash
swift build              # compiles AudioFeederApp (and the core)
swift run AudioFeederApp # runs from the SwiftPM build for development
```

> **Packaging caveat:** a SwiftPM executable (`swift run`) is fine for development, but the
> menu-bar-only behavior (`LSUIElement`), the microphone permission string, login-item
> registration (`SMAppService`), and signing/notarization all require a real `.app`
> **bundle**. Use `Packaging/build-app.sh` (below) to build one instead of `swift build`
> directly.

## Building a distributable `.app`

```bash
cd macos-audio-feeder

# Unsigned/ad-hoc build for local testing:
Packaging/build-app.sh

# Signed, for distributing to other Macs:
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" Packaging/build-app.sh

# Signed + notarized + stapled, zipped up and ready to hand out:
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  NOTARIZE_PROFILE=<keychain-profile> \
  Packaging/build-app.sh
```

`NOTARIZE_PROFILE` refers to credentials stored ahead of time via
`xcrun notarytool store-credentials`; see the comment at the top of the script. Beyond a
plain `swift build`, the script assembles `Contents/{MacOS,Resources,Frameworks}` from
`Packaging/Info.plist` and `Packaging/AudioFeeder.entitlements`, and embeds the LiveKit SDK's
WebRTC/UniFFI XCFrameworks (which SwiftPM otherwise links from inside `.build/`, breaking the
moment the binary moves) — the equivalent of Xcode's "Embed Frameworks" build phase, done by
hand with `otool`/`install_name_tool`. It requires macOS + Xcode command line tools and was
written and reviewed without access to those (this repo's automation runs on Linux), so **the
framework-embedding step is unverified and the most likely thing to need a fix on first real
run**. Run it with `bash -x Packaging/build-app.sh` to see what it finds.

Once built, install by copying `.build/Audio Feeder.app` to `/Applications` (needed for
`SMAppService` login-item registration to behave normally) and launching it once to grant
the microphone permission prompt.

## Status

- [x] Pure core + unit tests (scheduler, level/RMS, channel pick, config, token contract)
- [x] Capture (`AudioCapture`: AVAudioEngine bound to device by UID, channel extraction)
- [x] Device enumeration + hot-plug (`DeviceMonitor`, CoreAudio)
- [x] LiveKit publisher (`Publisher`: token fetch, manual rendering + mixer.capture,
      retry/backoff, identity release on stop) — custom-audio publishing verified end-to-end
      on real hardware
- [x] Orchestration (`AppController`: schedule eval, manual override, waiting-for-device)
- [x] Menu-bar UI (NSStatusItem + NSPopover) + settings window + login-item toggle
- [ ] Package as a signed/notarized `.app` bundle — tooling written (`Packaging/build-app.sh`),
      **not yet run on real hardware**; framework embedding is the part most likely to need
      a fix
- [ ] (Optional) WKWebView transcript/translations pane
