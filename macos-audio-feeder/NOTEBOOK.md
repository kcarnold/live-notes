# Audio Feeder — development notebook

A running log for the macOS Audio Feeder app: what was tried, what broke, what the platform
actually does, and why the code looks the way it does. `README.md` documents *how to use it*;
this file records *how we got here*, so a decision doesn't have to be re-derived from scratch
six months later.

Newest entries at the top. Keep entries dated and concrete — a symptom, the evidence, the
cause, the fix.

---

## 2026-07-27 — App Sandbox blocked WebRTC's UDP sockets (the venue failure)

**Symptom.** First run on the tech booth Mac (Intel Mac mini 8,1, macOS 15.7.7) never
published. The app looped: connect, fail, back off, retry. The browser broadcast page on the
same machine and network worked fine, so we fell back to that. Log:
`audio-feeder-fail-log.txt`.

**The evidence was in what the log did *not* contain.** Across ~400 lines and 3 full connect
cycles there were 42 ICE candidates, and every single one was `tcp … tcptype active`:

```
udp host candidates:  0
srflx (STUN):         0
relay (TURN):         0
tcp  tcptype active: 42
```

A WebRTC client producing zero UDP candidates is not a network problem. `tcptype active`
is the *only* candidate type reachable with `connect()` alone; every other kind needs
`bind()` on a local port.

**Cause.** The bundle shipped `com.apple.security.app-sandbox` +
`com.apple.security.network.client`, and **not** `com.apple.security.network.server`. The
App Sandbox splits networking into two operations:

| Sandbox operation | Granted by | Covers |
|---|---|---|
| `network-outbound` | `com.apple.security.network.client` | `connect()` |
| `network-inbound`  | `com.apple.security.network.server` | `bind()`, `listen()` |

An ICE agent needs both — it binds a local UDP port per candidate and receives from
arbitrary peers. Reproduced with a 40-line C program doing exactly what libwebrtc's port
allocator does (`socket` → `bind(0.0.0.0:0)` → `sendto` a public STUN server → `recvfrom`),
signed three ways and run on an **arm64** Mac:

| Signing | Result |
|---|---|
| Unsandboxed | `bind` OK → STUN reply received |
| sandbox + `network.client` (what we shipped) | **`bind: Operation not permitted` (EPERM)** |
| sandbox + `network.client` + `network.server` | `bind` OK → STUN reply received |

So **Intel was a red herring** — it reproduces on Apple Silicon too.

**How the EPERM became a 3-minute retry loop.** Worth tracing, because the log looks like a
network flake and isn't:

1. No UDP port binds → only TCP-active candidates gathered.
2. The signal WebSocket connects fine (outbound TCP is allowed) — hence a real
   `didReceiveConnectResponse` with `ServerInfo` at every region.
3. `fullConnectSequence` then waits on `primaryTransportConnectedCompleter` with
   `primaryTransportConnectTimeout`, default **10s** (`Room+Engine.swift`). ICE never
   completes → timeout.
4. `Room.connect` wraps that in `connectWithCloudRegionFailover`, so it walks all six
   LiveKit Cloud regions (US Central, Canada, US East B, US West B, Canada B, US West C)
   before throwing — the ~60s sweep visible in the log.
5. `Publisher` catches → `.failed` → `AppController` tears down and backs off → repeat.

All the `WebSocket is nil` / `connectionState is .disconnected` noise is *downstream*: the
SDK closed the socket on timeout and queued trickle candidates then failed to send.

**Why it had "worked" before — the process lesson.** Everything ever verified end-to-end ran
**unsandboxed**. `AudioFeederApp` was a SwiftPM `.executableTarget` (`swift run`) — a bare
Mach-O with no entitlements — and so was the spike removed in `11f3db0` as "proven".
`a30dafc` (Jul 25) switched to the XcodeGen app target, which is the first time
`CODE_SIGN_ENTITLEMENTS` was ever applied to a running binary. The next run after that commit
was at the venue, two days later.

> **Rule this earns:** packaging changes are behaviour changes. An entitlements file, a
> sandbox, a hardened runtime, or a signing identity can break a program that "works" under
> `swift run`. Never let the first run of a newly-packaged build be the one that matters.

Chrome ships the server entitlement, which is why the browser page kept working.

**Fix.** `Packaging/AudioFeeder.entitlements` — add `com.apple.security.network.server`.

**Also fixed in the same pass** (all found by reading the code, not reproduced):

- **No logging.** The only `NSLog` in the whole app was in `LoginItem`. The thrown
  `Room.connect` error went straight into `status = .error(...)` — rendered *only* in the
  menu-bar popover, which was itself broken. The one fact that identified the failure was
  unobservable on site. Now everything meaningful goes through `os.Logger` under subsystem
  `org.kenarnold.audio-feeder`; see README → Watching the logs.
- **Popover blank space above/below.** `NSPopover` sizes itself from its content view
  controller's `preferredContentSize`, and `NSHostingController` only publishes SwiftUI's
  ideal size if you set `sizingOptions = [.preferredContentSize]` (macOS 13+). We never did,
  so the popover kept a stale frame while content grew and shrank. Made much worse by
  `status = .error("\(error)")` stuffing a multi-line LiveKit error into a `Text`.
- **Schedule editor "unresponsive."** The `HH:mm` `TextField` binding only wrote back when
  `Schedule.parseHHMM` succeeded. Every intermediate keystroke is invalid, so the setter
  no-op'd, SwiftUI re-rendered the *old* formatted value, and the keystroke visibly vanished.
  The field was fighting the typist, not hung. Fixed with local `@State` text that commits on
  valid input / blur.

**Known-remaining, not yet fixed** (real, but not what broke the service):

- `throwing -10877` (`kAudioUnitErr_InvalidElement`) ×4 immediately before each
  `Room.connect`, from `AudioCapture.start()`. Most likely `inputNode.inputFormat(forBus: 0)`
  returning a 0ch/0Hz format, which is what a denied microphone TCC grant looks like — and an
  ad-hoc-signed Xcode build has an unstable code identity, so the grant doesn't survive
  rebuilds. Secondary suspect: `AudioCapture` sets `kAudioOutputUnitProperty_CurrentDevice`
  on the shared AUHAL, which on macOS binds **both** the input and output scopes, so a board
  with no output channels can produce the same error. The new logging prints the resolved
  format, which should settle it.
- `HALC_ProxyIOContext::IOWorkLoop: skipping cycle due to overload`. The tap block runs on the
  real-time render thread and allocates a fresh `AVAudioPCMBuffer` (`ChannelExtractor`), runs
  a scalar RMS loop, and spawns **two `Task { @MainActor }` per buffer**. In an unoptimized
  Debug build on a 2018 Intel mini that is enough to miss the IO deadline.
- `AppController.evaluate()` runs a full synchronous CoreAudio device enumeration on the main
  thread, and is called on *every* `config` mutation — i.e. on every keystroke in the settings
  window, plus every 15s, plus every hot-plug notification.
- `DeviceMonitor.stopMonitoring()` passes a *different* block to
  `AudioObjectRemovePropertyListenerBlock` than was added, so it cannot actually remove the
  listener. Currently harmless — nothing calls it.

**Operational takeaway for unattended runs.** Don't run from Xcode. Build the `.app` once via
`Packaging/build-app.sh`, copy to `/Applications`, launch, grant the microphone prompt, and
don't rebuild — so the TCC grant stays attached to one stable code identity.

---

## Earlier history (reconstructed from git, 2026-06-30 → 2026-07-26)

Not contemporaneous notes — assembled after the fact from commit messages and code, recorded
here so the shape of the project isn't lost.

- **`bad75d9` (Jun 30) — initial app.** Established the split that still holds:
  `AudioFeederCore` as a pure, dependency-free SwiftPM library (Config, Scheduler, LevelMeter,
  ChannelExtractor, ToneGenerator, LiveKitTokenClient) with fast unit tests, and
  `AudioFeederApp` for the AVFoundation/CoreAudio/LiveKit/SwiftUI parts. The app publishes as
  `organizer-host` — deliberately the same identity `src/BroadcastControl.tsx` uses — so the
  server needs no changes and the browser page stays a working alternative. (LiveKit allows
  one participant per identity, so they are mutually exclusive by construction.)
- **`85c3938` (Jul 18) — menu bar rewritten off `MenuBarExtra`.** SwiftUI's
  `MenuBarExtra(.window)` auto-dismisses the moment a child menu or sheet takes key focus,
  which made the device `Picker` flicker away on click. Replaced with `NSStatusItem` +
  `NSPopover` driven from an `AppDelegate`; the settings controls moved into the standard
  `Settings` scene (a real window). This is why the app has an AppKit delegate at all.
- **`48ee934` / `11f3db0` (Jul 26) — spike proven and deleted.** `AudioFeederSpike` existed to
  de-risk the linchpin: does the LiveKit Swift SDK's custom-audio path
  (`AudioManager.setManualRenderingMode(true)` + `mixer.capture(appAudio:)`) actually publish
  on macOS? It did, on real hardware with a real sound board, so the spike was removed and its
  one durable finding — the Aggregate Device fallback if a future SDK release breaks those API
  names — folded into a doc comment on `Publisher.swift`. **Note in hindsight:** this
  verification ran unsandboxed, which is precisely what the 2026-07-27 entry is about.
- **`a30dafc` (Jul 25) — XcodeGen app target.** Hand-rolling framework embedding with
  `otool`/`install_name_tool` was tried first and got it wrong (it picked up a `__MACOSX/`
  resource-fork stub instead of the real 2 MB framework, and `codesign` rejected the result).
  LiveKit ships WebRTC/UniFFI as binary XCFrameworks; embedding, re-signing and runtime
  resolution inside a `.app` is exactly what an Xcode app target does for free. `project.yml`
  is the reviewable source of truth; the `.xcodeproj` is generated and not checked in.
  Hardened runtime is off for Debug on purpose — it enables *library validation*, which
  requires every loaded library to share the main executable's Team ID, and LiveKit's
  XCFrameworks only get ours when a real Developer ID re-signs them during archive/export.
