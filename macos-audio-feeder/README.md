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
- Xcode 15+ (to build the app bundle); a plain Swift toolchain is enough for `swift test`
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) — the
  `.xcodeproj` is generated, not checked in
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

## Project layout

```
macos-audio-feeder/
  Package.swift          # AudioFeederCore ONLY — pure logic + tests, no dependencies
  project.yml            # XcodeGen spec for the app; AudioFeeder.xcodeproj is generated
  Sources/
    AudioFeederCore/     # pure, tested: Config, Scheduler, LevelMeter, ChannelExtractor,
                         #               ToneGenerator, LiveKitTokenClient, DisconnectPolicy
    AudioFeederApp/      # the menu-bar app (capture + publish + UI)
  Tests/
    AudioFeederCoreTests/
```

The split is deliberate. `Package.swift` holds only the pure core, so `swift test` stays
fast, needs no Xcode, and (for the non-AVFoundation parts) runs on Linux. The **app** is
built by Xcode, because a real `.app` bundle needs app-target machinery SwiftPM doesn't have:
the LiveKit SDK ships WebRTC/UniFFI as binary XCFrameworks that must be embedded and
re-signed inside the bundle, plus Info.plist processing, entitlements, the hardened runtime,
and signing/notarization. (Hand-rolling that embedding with `otool`/`install_name_tool` was
tried first and got it wrong — it picked up a `__MACOSX/` resource-fork stub instead of the
real 2 MB framework, and `codesign` rejected the result.)

## Tests

```bash
swift test    # AudioFeederCore: scheduler, level/RMS, channel extraction, config,
              # token contract, disconnect policy
```

## Building and running the app

The `.xcodeproj` is **generated from `project.yml` and not checked in** — that YAML is the
reviewable source of truth, since an `.xcodeproj` is XML that conflicts badly on merge.

```bash
cd macos-audio-feeder
brew install xcodegen     # once
xcodegen generate         # writes AudioFeeder.xcodeproj
open AudioFeeder.xcodeproj # then just hit Run
```

Re-run `xcodegen generate` after changing `project.yml` (or after adding source files, since
the file list is captured at generation time).

## Write key

Publishing takes the room's microphone — and because every broadcaster shares the
`organizer-host` identity, it evicts whoever is currently speaking. The server therefore
gates organizer tokens on a shared per-device key ([docs/WRITE_KEYS.md](../docs/WRITE_KEYS.md)).

Paste this machine's key into **Settings → Server → Write key**. It rides on the
`/api/livekit/token` request as `X-Write-Key`; nothing else about the request changes. While
the server runs in `observe` mode a blank key still works, so the feeder keeps publishing
until the server switches to `enforce`.

The key is persisted in the app's plaintext JSON config alongside the other settings, not the
Keychain — proportionate for a key that grants a room's microphone and is rotated by editing
the server's `WRITE_KEYS`.

## Watching the logs

The app has no console window and, when it's doing its job, no visible UI beyond a menu-bar
glyph. Everything it does goes to **unified logging** (`os.Logger`) under the subsystem
`org.kenarnold.audio-feeder`, so you can watch a run live — or reconstruct one after the
fact — from any Terminal, with no debugger and no Xcode attached. This works identically for
an app launched from the Finder, from a login item, or from Xcode.

**Watch live** (leave this running in a Terminal while you test):

```bash
log stream --predicate 'subsystem == "org.kenarnold.audio-feeder"' --style compact
```

**Look at what already happened** — this is the important one, because unified logging is a
ring buffer that's always recording. If the app misbehaved ten minutes ago and you *weren't*
streaming, the logs are still there:

```bash
log show --predicate 'subsystem == "org.kenarnold.audio-feeder"' --last 30m --style compact
```

Useful variations:

```bash
# Just one category: controller | capture | publisher | devices
log stream --predicate 'subsystem == "org.kenarnold.audio-feeder" AND category == "publisher"'

# Errors only, across the whole app
log show --predicate 'subsystem == "org.kenarnold.audio-feeder" AND messageType == "error"' --last 1h

# Include the LiveKit SDK's own chatter alongside ours (noisy, but this is where
# ICE/WebSocket failures show up)
log stream --predicate 'subsystem == "org.kenarnold.audio-feeder" OR process == "Audio Feeder"'

# Hand a whole session to someone else
log show --predicate 'process == "Audio Feeder"' --last 1h --style compact > feeder.log
```

`--style compact` is the readable one; `--style syslog` adds full timestamps, and
`--style json`/`ndjson` are there if you want to post-process. Add `--info --debug` to
include lower-priority levels (we log at `notice` and `error`, which are captured by default
and persisted to disk — `info` and `debug` messages are memory-only and need the flags).

> **Gotcha:** `log` is a builtin in some shells (fish among them), which will swallow these
> arguments and report something unhelpful like `too many arguments`. If that happens, spell
> it `/usr/bin/log`.

Console.app is the GUI equivalent if you prefer clicking: paste the same predicate into its
search field. The system log is a ring buffer that is always recording every process on the
machine, so `log show` works retroactively even for a run you didn't plan to observe — which
is exactly the situation the on-site failure created.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Status cycles `Connecting…` → `Error` → repeat, ~60s per attempt | Room connect is timing out at every LiveKit Cloud region. Check the `publisher` category for the real error. If the app is sandboxed without `com.apple.security.network.server`, WebRTC can't bind UDP ports and ICE never completes — see `NOTEBOOK.md`. |
| `input format is empty (0.0 Hz, 0 ch)` | Microphone permission denied. Check System Settings → Privacy & Security → Microphone. Ad-hoc-signed builds get a new code identity on every rebuild, so the grant doesn't stick — build the `.app` once and stop rebuilding it. |
| `token endpoint returned HTTP 503` | The server has no `LIVEKIT_*` configuration. |
| Publishes, but the browser broadcast page stops working | Expected. Both join as `organizer-host`, and LiveKit allows one participant per identity — use one or the other. |
| `Stopped — Taken over by the broadcast page` | The reverse of the row above: someone opened the broadcast page and it evicted the app. The app stays down on purpose rather than fight for the room. Close the page, then click **Reconnect** in the popover. |
| `Stopped — Removed from the room` | Someone removed this participant server-side (LiveKit dashboard or CLI). Same deal: **Reconnect** to come back. |
| `Reconnecting…` for a while, then `Disconnected: …` and a retry | Normal recovery. The SDK handles brief network trouble itself; anything it can't recover — including a token hitting its 4h TTL — tears the pipeline down and reconnects with backoff (2s doubling to 30s). |

Recovery behaviour is decided by `DisconnectPolicy` in `AudioFeederCore` and is unit-tested;
`NOTEBOOK.md` (2026-07-30) has the reasoning.

## Building a distributable `.app`

`Packaging/build-app.sh` wraps the above plus `xcodebuild archive`/`-exportArchive`; it
regenerates the project first, so it's always in sync with `project.yml`.

```bash
cd macos-audio-feeder

# Unsigned build for local testing:
Packaging/build-app.sh

# Signed Developer ID build:
TEAM_ID=ABCDE12345 Packaging/build-app.sh

# Signed + notarized + stapled, zipped and ready to hand out:
TEAM_ID=ABCDE12345 NOTARIZE_PROFILE=<keychain-profile> Packaging/build-app.sh
```

`NOTARIZE_PROFILE` refers to credentials stored ahead of time via
`xcrun notarytool store-credentials`; see the comment at the top of the script. Output lands
under `.build/xcode/`.

Install by copying `Audio Feeder.app` to `/Applications` (needed for `SMAppService`
login-item registration to behave normally) and launching it once to grant the microphone
permission prompt.

> **Dependency pinning:** `.gitignore` excludes `Package.resolved` and the generated
> `.xcodeproj` (which is where Xcode keeps its own resolved versions), so the exact LiveKit
> revision isn't committed — `project.yml`'s `from: 2.0.7` only pins the major version. If a
> reproducible-to-the-commit build matters later, check in the resolved file.

## Status

- [x] Pure core + unit tests (scheduler, level/RMS, channel pick, config, token contract)
- [x] Capture (`AudioCapture`: AVAudioEngine bound to device by UID, channel extraction)
- [x] Device enumeration + hot-plug (`DeviceMonitor`, CoreAudio)
- [x] LiveKit publisher (`Publisher`: token fetch, manual rendering + mixer.capture,
      retry/backoff, identity release on stop) — custom-audio publishing verified end-to-end
      on real hardware
- [x] Orchestration (`AppController`: schedule eval, manual override, waiting-for-device,
      pipeline reconciliation)
- [x] Losing the room is noticed and recovered from (`RoomDelegate` → `DisconnectPolicy`) —
- [x] Menu-bar UI (NSStatusItem + NSPopover) + settings window + login-item toggle
- [x] Build a real `.app` bundle (Xcode target generated from `project.yml`; frameworks
      embedded automatically)
- [ ] Sign + notarize a distributable build — `Packaging/build-app.sh` has the
      archive/export/notarize path, but it needs a `TEAM_ID` and a Developer ID cert to
      exercise, so **that half is still unrun**
- [ ] (Optional) WKWebView transcript/translations pane
