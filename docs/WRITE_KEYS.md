# Write keys

Reading a session is open to anyone with the link. **Writing** — editing the notes, taking
the microphone, spending money on models and TTS — is gated on a shared key.

The unit being authorized is a **device**, not a person: the booth laptop, the tablet on the
music stand, the Proclaim Mac, the audio feeder. There are no accounts and no logins. Each
device is given a key once and keeps it.

## What a key protects

| Endpoint | Needs a key |
|---|---|
| `POST /api/ys-auth` with `isEditor: true` (a *writable* Y-Sweet token) | yes |
| `POST /api/ys-auth` for a read-only token | no — anyone may watch |
| `POST /api/livekit/token` with `role: organizer` (the microphone) | yes |
| `POST /api/livekit/token` as a listener | no |
| `POST /api/translateItem`, `/api/slideConversation/message`, `/api/slideConversation/note` | yes |
| `POST /api/requestTranslatedBlocks` | yes |
| `POST /api/slideLibrary` (upsert a reviewed translation) | yes |
| `GET /api/slideLibrary`, `POST /api/slideLibrary/lookup` | no |
| `POST /api/tts`, `POST /api/livekit/translate` | no — **viewers call these** |

The last row is the deliberate gap: listeners legitimately request TTS and translator bots,
so those endpoints cannot require an editor's key. They are still unauthenticated and still
cost money. Not built yet (TODO): ensure that `/api/tts` can only speak lines that are in the current notes, and there's a maximum number of live translator bots (`/api/livekit/translate`) at a time.

## Configuring the server

Two environment variables:

```sh
# A comma-separated list. Each entry is `label:key`, or a bare `key`.
# The label is only used in logs — it answers "which device is this?".
WRITE_KEYS=proclaim:kZ8x…,booth:9fQ2…,tablet:Lm4v…,feeder:t7Rb…

# off | observe | enforce   (default: observe)
WRITE_AUTH_MODE=observe
```

Generate a key with `openssl rand -hex 24`.

### The three modes

- **`off`** — no checking, no logging. Also the automatic mode when `WRITE_KEYS` is empty, so
  an install that doesn't use this feature is unaffected.
- **`observe`** (default) — every privileged request is checked and recorded, then **allowed
  regardless**. Nothing is refused. This is how a rollout starts.
- **`enforce`** — unauthorized privileged requests are refused.

Asking for `enforce` with no keys configured makes the server refuse to start, rather than
booting into a state where every device — including the Proclaim service — is locked out.

## Rolling it out

1. Set `WRITE_KEYS` and leave the mode at `observe`. Distribute keys to the devices (below).
2. Run a service. Then read the logs, or the `write_auth_check` event in PostHog:

   ```
   [write-auth] observe /api/ys-auth key=proclaim → ok
   [write-auth] observe /api/livekit/token key=none ip=192.168.1.40 → MISSING (allowed — observe mode)
   [write-auth] observe /api/ys-auth key=unknown(3f2a9c11) ip=192.168.1.51 → INVALID (allowed — observe mode)
   ```

   Every line with `key=none` or `key=unknown` is a device that would have been locked out.
   Chase those down first. The audit says as much as it can about who asked: the caller's
   address, a truncated user agent, and — for a key that was presented but not recognized —
   a short digest of it. That digest is what separates "still on last month's key" from
   "junk", and being stable it makes every un-migrated device one bucket to watch drain.

   The same fields ride on the PostHog `write_auth_check` event, filed under the device
   label when known, else `stale-key-<digest>`, else `no-key-<ip>` — so "has the tablet been
   provisioned yet?" is a chart, not a grep.
3. When nothing but the odd stray shows up missing, set `WRITE_AUTH_MODE=enforce` and restart.

## Giving a device its key

**Browser (booth laptop, tablet).** Three ways in, all landing in the same
`localStorage` slot:

1. **It asks.** Open an `#editor` URL on a device the server doesn't recognize and the page
   prompts for a key, stores what you paste, and retries. Once per page load, whatever the
   answer — cancelling continues read-only rather than nagging on the next reconnect. This
   fires in `observe` mode too, where nothing is refused, because that is when devices are
   supposed to be getting their keys.
2. **The status page.** `/status` shows whether this device has a key and the last four
   characters of it, with a box to paste a new one and a button to clear it. This is the one
   to use for rotation: the masked tail answers "has this tablet moved to the new key yet?"
   without putting the secret on a screen.
3. **A URL, for a device you're setting up in advance:**

   ```
   https://…/sourceText#editor&key=THEKEY
   ```

   The key is stored and stripped from the address bar immediately, so it doesn't linger on
   screen or in a bookmark — though a URL you *typed* still lands in the browser's own
   history and omnibox suggestions, so prefer (1) or (2) on a shared machine. A `?key=THEKEY`
   query parameter works too, but prefer the fragment: it never reaches the server's access
   log.

Every later visit — plain `#editor`, no key — is authorized. Clearing site data (or a
different browser, or a private window) means provisioning again.

**Proclaim service.** Pass it to the installer:

```sh
bash install_proclaim_service.sh --server-url=https://… --write-key=THEKEY
```

It lands in the LaunchAgent plist as `PROCLAIM_WRITE_KEY`. Reinstalling without
`--write-key=` keeps the key already installed. The service logs `Write key: configured` (or
`NOT configured`) at startup — never the key itself.

**macOS audio feeder.** Settings → Server → *Write key*.

## Rotating

The server holds many keys at once; each device holds exactly one. That asymmetry is what
makes rotation work — the overlap lives in `WRITE_KEYS`, and devices move across it one at a
time.

**Not during a service.** Every `WRITE_KEYS` edit needs a server restart, and a restart drops
the live translator bridges and the broadcaster's room along with it. Rotate on a weekday.

1. **One edit, one restart.** Add the new key *and* relabel the old one to say it's on its
   way out:

   ```sh
   WRITE_KEYS=booth-old:OLDKEY,booth:NEWKEY,proclaim:…,feeder:…
   ```

   Labels are display-only — nothing compares them — so renaming an entry doesn't disturb
   the device still using it. What it buys you is a name for the un-migrated: the booth
   laptop keeps working and now announces itself in the logs as `key=booth-old`.

2. **Move the devices** (see the previous section: `/status` is the one to use here — the
   masked tail tells you whether a device has actually moved). Watch the logs:

   ```
   [write-auth] observe /api/ys-auth key=booth-old ip=192.168.1.40 → ok
   ```

3. **When `booth-old` stops appearing, delete it** and restart again. That silence is the
   completion criterion — better than trying to remember which devices you got.

Removing a device's key is also how you revoke it. Two caveats:

- **A Y-Sweet token already issued stays valid until it expires.** Revoking a key stops the
  *next* token from being issued, not the one in flight.
- **A key is per-device only by convention.** Nothing stops two devices sharing one, and the
  server can't tell that they do. If you rotate a key to lock out a lost tablet, that only
  works if nothing else was ever given the same key. The server warns at boot when two
  labels share a key value, which catches the accident but not the habit.

### Keys the server can't reach

The Proclaim Mac and the audio feeder are rotated by hand, on the machine — the installer's
`--write-key=` and the feeder's settings pane. There is no remote path. For the feeder in
particular this means a rotation is a trip to the booth, so give it a key you're content to
leave in place, and confirm it in the server log (`key=feeder → ok`) rather than by looking
at the machine.

## What this is and isn't

It is a lock on the door: someone who finds the URL can't scribble on the notes or evict the
speaker from the microphone mid-service.

It is not per-user access control, and it doesn't pretend to be. Everyone with a key can do
everything, keys are shared, keys live in browser storage and a plist, and anyone holding one
can pass it on. There is no audit trail beyond the key's label. For the failure modes this is
meant to prevent — a stranger with the link, a misconfigured device, an accidental edit from
the wrong tab — that's the right size. For anything stronger, this is the wrong design.
