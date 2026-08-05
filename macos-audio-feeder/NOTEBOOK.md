# Audio Feeder — development notebook

A running log for the macOS Audio Feeder app: what was tried, what broke, what the platform
actually does, and why the code looks the way it does. `README.md` documents *how to use it*;
this file records *how we got here*, so a decision doesn't have to be re-derived from scratch
six months later.

Newest entries at the top. Keep entries dated and concrete — a symptom, the evidence, the
cause, the fix.

---

## 2026-08-05 — the weekday chips were invisible state

**Symptom.** On an older macOS, clicking a day in **Settings → Schedule** changed nothing on
screen. On a newer one it did highlight, but you still couldn't tell which appearance meant
"the feeder will run this day" — nor, from that row, whether it would run at all.

**Cause.** The row was seven `Button`s styled `.bordered` and differentiated *only* by
`.tint(on ? .accentColor : .gray)`. `tint` is a **hint**: AppKit's bordered push button is
free to ignore it, and older systems do exactly that, so both states rendered as the same
grey push button. Where it is honoured, the difference is accent-tinted vs grey-tinted — a
colour difference with no shape, no glyph and no label saying which one is "on". The state
was there in the config the whole time; the UI just never committed to showing it.

**Fix, two halves.**

- **Draw the state ourselves.** `WeekdayButton` is a `.buttonStyle(.plain)` chip with its own
  fill, border, weight and glyph: filled accent + checkmark + semibold when scheduled,
  outlined + dash + regular when skipped. Nothing about it is a hint, so it renders the same
  on every system we deploy to, and it survives the loss of colour (colour-blind operator,
  washed-out booth monitor). It also gained a tooltip and proper accessibility label/value —
  it was previously an unlabelled `Sun` with no selected state exposed at all.
- **Say the outcome in words.** `Schedule.summary` renders one sentence — *"Runs Sun,
  10:00–12:00."* — under the times, orange when the schedule can never fire. This is the half
  that answers the second complaint, because *no* chip appearance can distinguish these three
  do-nothing configurations, which look identical in the row:

  | Configuration | Chip row shows | Summary says |
  |---|---|---|
  | `enabled == false` | a full week of chips | Schedule off — nothing will start the feeder on its own. |
  | `days.isEmpty` | nothing selected | No days selected — the schedule will never start the feeder. |
  | `startMinute == stopMinute` | a full week of chips | Start and stop are the same time — the schedule will never start the feeder. |

  It also spells out the wrapping window (*"Runs Sat, 23:00–01:00 the next day."*), which is
  the one place `days` doesn't mean "runs on this day" — `Scheduler.isWithinWindow` anchors a
  wrapping run to its **start** day, so Sunday 00:30 belongs to Saturday's window. Nothing in
  the UI had ever said so.

**Where it lives.** The sentence is built in `Schedule` (`AudioFeederCore`), not the view, so
`swift test` covers it with no Xcode and no UI. `ConfigTests` pins each inert case, and
`testWillEverRunAgreesWithScheduler` sweeps a full week minute-by-minute through the real
`Scheduler.shouldRun` to prove that "will never start the feeder" is the truth and not a
second, drifting opinion about the schedule.

**Rule this earns:** if a control's state is only a `tint`, the app has no state on screen.
Anything the operator has to read at the booth gets a shape or a glyph, and anything that
decides whether we go on air gets a sentence.

**The same sentence went into the menu-bar popover**, which had the identical gap one level
up: it said what the feeder was doing *now* ("Idle") and never whether anything would change
that. An install with the schedule switched off sits at "Idle" indefinitely and looks exactly
like one that is five minutes from going live.

### Then the same bug turned out to be in the popover's controls (same day, on review)

First run on a real Mac produced the right question: *what does "Follow schedule" do, and why
is it separate from the "Enable schedule" checkbox?*

It's a fair question because the UI never answered it. There are two switches, and the
popover's three buttons hid which one they were:

| | Where | Decides |
|---|---|---|
| **When to publish** (`manualOverride`) | popover | whether the schedule is consulted **at all** |
| **Enable schedule** + days + times | settings | what "Schedule" mode *does* |

The mode is the **outer** switch, and "Follow schedule" read like a sibling of "Enable
schedule" instead — same words, opposite level. Worse, the mode was never displayed: you
inferred it from which of `Start now` / `Stop now` was greyed out, and `Follow schedule`
appeared *only* while an override was active, so the state you were in was the one thing the
control couldn't show you. That is the exact defect this entry started with, one level up.

Replaced by a segmented **When to publish**: `Schedule | Always on | Always off`. The
selection *is* the state, there are visibly exactly three of them, and the sentence beneath
now describes the effective mode (`FeederConfig.modeSummary`), not just the schedule — because
"Runs Sun, 10:00–12:00" is actively misleading while the mode is *Always off*. It routes
through the controller's existing `startNow()` / `stopNow()` / `followSchedule()` rather than
writing `manualOverride`, since two of those also clear a stand-down.

`FeederConfig.willStartUnattended` answers the question neither control answers alone — *will
anything start this without a person?* — and it is what colours the line orange. For a feeder
whose whole job is running unattended, that's the sentence worth having.

**Also:** on macOS 26 the grouped-form text fields have no visible bezel, so a field holding a
value is indistinguishable from a label holding a value — nothing said "you can type here".
`.textFieldStyle(.roundedBorder)` on the `Form`. Same disease as the weekday chips, third
instance in one screen: **state and affordance both have to be drawn, not implied.**

**Verified.** `swift test` (45 tests) and `xcodebuild build` both clean on macOS 26 / Swift
6.3.3, and the settings window was driven by hand: chips toggle visibly, the summary tracks.
The popover's new mode picker is compiled and tested but **not yet clicked** — nobody launched
the app to work it, because launching a second feeder takes the room's microphone from
whoever has it. Work it once before the next service.

---

## 2026-07-30 — the feeder now notices when it stops publishing (#97)

**Symptom.** The app could stop publishing and never find out. The menu bar kept saying
"Publishing", `AudioCapture` kept pushing buffers into a room that wasn't there, and nothing
recovered or complained. For a program whose whole purpose is running unattended, that is the
worst failure shape available: it looks fine and does nothing.

**Three independent things had to be true for that to happen**, which is why it survived so
long — fixing any one of them alone would not have helped.

1. **`Publisher` never observed the room.** It registered no `RoomDelegate`, so `state` was
   only ever written by our own `connect()`/`stop()`. Once it reached `.connected` it stayed
   there for the lifetime of the object no matter what the room did.
2. **`AppController` couldn't act on it even in principle.** `.disconnected` did
   `if case .publishing = status { status = .idle }` — no teardown, no retry — and only
   `.failed` (which nothing could produce after a successful connect) led to recovery.
3. **The restart guard in `evaluate()` was `capture == nil`.** After a drop the pipeline is
   *half* alive — capture running, room dead — so `capture` was still non-nil and the guard
   skipped the restart forever. A half-alive pipeline was indistinguishable from a healthy one.

**The SDK deliberately won't save us.** It does handle transient network trouble itself
(resume / full reconnect). But on a terminal leave it calls `cleanUp(withError:)` and stays
down — correctly, since retrying an eviction just gets you evicted again
(`Room+SignalClientDelegate.swift`).

**What actually triggers it.** Duplicate identity is the likely one: the app and
`src/BroadcastControl.tsx` both join as the literal identity `organizer-host`, and LiveKit
permits one participant per identity, so anyone opening the broadcast page silently evicts the
app. Then token expiry — tokens are issued with `ttl: '4h'` (`server.ts`), which an always-on
install is guaranteed to hit. Then terminal server-side disconnects.

**Fix, in three parts.**

- `Publisher` registers a `RoomDelegate` and maps `roomIsReconnecting` / `roomDidReconnect` /
  `room(_:didDisconnectWithError:)` onto two new states, `.reconnecting` and
  `.dropped(DisconnectCause)`.
- `AppController` treats `.dropped` as actionable: consult `DisconnectPolicy`, then either
  teardown + backoff retry, or stand down.
- `evaluate()`'s guard became `isPipelineRunning` — both halves alive, publisher in a live
  state — so the 15s tick *reconciles* the pipeline instead of only ever starting one. This is
  the belt-and-braces half: even if a delegate callback were missed entirely, the tick repairs
  a half-dead pipeline within 15s.

**The policy question, and why it isn't "always reconnect".** Reconnecting is right for token
expiry, server restarts and lost connections — and it re-fetches a token, which is what makes
the 4h TTL survivable. It is wrong in exactly the cases where a *second actor* deliberately
took our place, because then retrying starts a fight:

| Cause | Response | Why |
|---|---|---|
| `duplicateIdentity` | stand down | The shared `organizer-host` identity is what *enforces* "only one broadcaster". Reconnecting would evict whoever just evicted us, who would evict us straight back. |
| `participantRemoved` | stand down | Nothing in live-notes removes participants, so this is a human with the dashboard or CLI kicking the feeder. Retrying takes away the only remote stop button there is. |
| everything else | retry, backed off | For an unattended feeder the expensive failure is silence. Anything unclassified — including a new `LiveKitErrorType` from an SDK bump — retries. |

`participantRemoved` goes beyond what #97 asked for (it named only duplicate identity). It is
one line and one test in `DisconnectPolicy` if that turns out to be the wrong call.

A stand-down is visible ("Stopped — Taken over by the broadcast page", orange dot), is logged,
and ends only two ways: a person clicks **Reconnect** in the popover, or the run window ends,
so next Sunday starts clean with nobody having to remember. It deliberately needs a click —
undoing a stand-down means evicting whoever is broadcasting now, which is a decision, not a
timer.

**Where the decision lives.** `DisconnectPolicy` is in `AudioFeederCore`, not next to the
LiveKit code, so the one judgement call in this fix is covered by `swift test` with no Xcode,
no SDK and no room. `Publisher` only maps `LiveKitErrorType` → `DisconnectCause`; everything
downstream is pure.

**Two lifecycle races closed on the way past**, both pre-existing:

- A superseded connect task could still write `state`. `stop()` during a token fetch made the
  attempt throw, and the `catch` reported `.failed` — a deliberate stop showing up as a
  connection failure, and earning a retry nobody asked for. Every state write in `connect()`
  is now gated on a session counter that `start()`/`stop()` bump.
- A connect that failed *after* `Room()` was created left the room dangling, still holding the
  `organizer-host` identity against the retry about to follow. The `catch` now disconnects it.

The same session counter is what stops our own `stop()` from being mistaken for an eviction:
`Room.disconnect()` fires `didDisconnectWithError(nil)`, which would otherwise arrive looking
like an unexplained drop.

> **Not verified on a machine.** This was written without a Swift toolchain — no build, no
> `swift test`, no run. Every SDK API used was read out of `client-sdk-swift` at both 2.0.7
> (the `from:` floor) and 2.15.3 (the current 2.x head), and the delegate signatures,
> `LiveKitErrorType` cases, `Room.add(delegate:)` and the weak `MulticastDelegate` are
> identical in both — but "the API exists" is not "it compiles", and by this notebook's own
> rule the first run that matters must not be the one at the venue. Run `swift test`, then
> exercise it against a real room: publish, open the broadcast page, and watch for
> `room dropped` → `staying down` in the `publisher`/`controller` log categories.

**Known limit, deliberately not fixed.** If the SDK were to sit in `.reconnecting` forever we
would wait forever with it — `isPipelineRunning` counts `.reconnecting` as alive on purpose,
so the tick doesn't tear down a recovery in progress. Bounding it needs a timeout longer than
the SDK's own full-reconnect budget, and that is a number to measure, not to guess.

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
  `Room.connect`, from `AudioCapture.start()`. **Cause not yet confirmed** — the leading
  theory is `inputNode.inputFormat(forBus: 0)` returning a 0ch/0Hz format, which is what a
  denied microphone TCC grant looks like from here, and an ad-hoc-signed Xcode build has an
  unstable code identity so the grant doesn't survive rebuilds. Secondary suspect:
  `AudioCapture` sets `kAudioOutputUnitProperty_CurrentDevice` on the shared AUHAL, which on
  macOS binds **both** the input and output scopes, so a board with no output channels can
  produce the same error. `AudioCapture` now logs the resolved format and refuses to install a
  tap on an empty one, so the next occurrence should identify itself instead of emitting a
  bare OSStatus.
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

### Pre-service checklist

Verify at a desk, not at the booth. Every failure above reproduces anywhere, so a clean run at
home is a real signal.

1. `xcodegen generate` (the file list is captured at generation time, and `Log.swift` is new).
2. `Packaging/build-app.sh`, then copy `Audio Feeder.app` to `/Applications`.
3. Confirm the entitlements actually made it into the product — this is the whole fix:
   ```bash
   codesign -d --entitlements - --xml "/Applications/Audio Feeder.app" | plutil -p -
   ```
   `com.apple.security.network.server` must be present.
4. Launch it, grant the microphone prompt, pick the board and channel.
5. With `log stream --predicate 'subsystem == "org.kenarnold.audio-feeder"' --style compact`
   running, set **When to publish** to *Always on* (this step said "hit Start now" before the
   2026-08-05 entry replaced those buttons) and watch for, in order: `starting pipeline`, an input format
   with a plausible sample rate and channel count, `token OK`, `room connected`,
   `publishing as organizer-host`.
6. Join the session in a browser and confirm you can hear the board.
7. Set the schedule, quit, relaunch, and confirm it comes back up on its own.

---

## 2026-07-27 — token contract re-verified against `main` (no change needed)

`main` grew a participant-attribute "tag" for the organizer, which raised the question of
whether `LiveKitTokenClient`'s request is stale. It isn't. Recorded so nobody re-derives it.

- **The request body is unchanged.** `server.ts` still reads `role` from the POST body, and
  `role === 'organizer'` is what sets `canPublish` on the grant. `requestBody` sends
  `{room, identity: "organizer-host", role: "organizer"}`, byte-for-byte what
  `src/BroadcastControl.tsx` sends. Dropping `role` would yield a token that connects fine
  and silently publishes nothing.
- **The tag is an output, not a new input.** The server *also* mirrors the role into a
  LiveKit participant attribute (`attributes: { role: 'organizer' }`), derived from the same
  request field. As of today nothing in production reads it — the only attribute actually
  consumed is `listen` (`LISTEN_ATTRIBUTE`), used by the translation supervisor to count
  per-language listener demand.
- **Broadcaster detection is still by identity prefix.** `ORGANIZER_PREFIX = "organizer-"` in
  both `live-audio/translation-session-manager.ts` and `src/ListenViewer.tsx`. So the literal
  identity `organizer-host` still matters, and the `AudioFeederCore` test asserting it is
  guarding the right thing.

Consequence worth keeping in view: because the app and the browser page use the *same literal
identity*, and LiveKit permits one participant per identity, they remain mutually exclusive by
construction. That policy is fine; what isn't is that the losing side dies quietly — `Publisher`
registers no `RoomDelegate`, so it never learns the room dropped, and `AppController` can't
restart a half-torn-down pipeline anyway. Filed as
[#97](https://github.com/kcarnold/live-notes/issues/97), which also covers the 4h token TTL and
whether the feeder should get its own identity (it can't, without first fixing the supervisor's
first-`organizer-*`-wins participant lookup).

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
