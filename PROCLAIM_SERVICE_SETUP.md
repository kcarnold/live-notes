# Running Proclaim Service as a macOS Service

This guide explains how to run `proclaim_service.py` as a persistent background service on macOS with auto-restart and date-change handling.

## Overview

The setup includes:
- **Service** (`proclaim_service.py`): Detects date changes and exits cleanly for restart
- **Launch wrapper** (`proclaim_service_launch.sh`): What the LaunchAgent actually runs — updates the checkout from the release branch, then starts the service
- **Plist template** (`org.kenarnold.proclaim-service.plist.template`): Template that gets customized during installation
- **Install script** (`install_proclaim_service.sh`): Generates the plist with your paths and user, then installs it
- **Log directory**: Logs stored at `~/Library/Logs/proclaim-service/`

The setup is portable—works with any user and any repo location.

## Installation

The install script automatically generates the plist from a template with your current paths and user, so it's portable across different systems.

### Run the installer

```bash
bash install_proclaim_service.sh --server-url=https://notelate.com
```

That's it! The installer will:
- ✓ Generate the plist from the template with your current user, paths, and log directory
- ✓ Create the log directory
- ✓ Install the plist to `~/Library/LaunchAgents/`
- ✓ Load the service

The service should now start automatically and restart on reboot.

Options:

| Flag | Meaning |
|---|---|
| `--server-url=<url>` | Y-Sweet / API server (default `https://notelate.com`) |
| `--branch=<branch>` | Release branch to track (default `proclaim-stable`) |
| `--write-key=<key>` | Shared key authorizing this machine's writes (see below). Omit on a reinstall to keep the installed key |
| `--no-auto-update` | Install without the pull-on-launch update; runs whatever is checked out |

### Write key

The server gates writes — full Y-Sweet tokens and `/api/translateItem` — on a shared
per-device key ([docs/WRITE_KEYS.md](docs/WRITE_KEYS.md)). Give this machine its key at
install time:

```bash
bash install_proclaim_service.sh --server-url=https://notelate.com --write-key=THEKEY
```

It is stored in the plist as `PROCLAIM_WRITE_KEY`, and is never fetched from the server
(`/api/config` is public). A reinstall without `--write-key=` carries the existing key
forward, so routine reinstalls don't de-authorize the machine.

To check that it took, look for this line at startup — it reports whether a key is
configured, never what it is:

```
Write key: configured
```

While the server runs in `observe` mode a missing key is recorded and still served, so
`NOT configured` is a warning rather than an outage — until the server switches to
`enforce`, at which point this machine stops being able to write.

## Automatic updates

The machine running Proclaim is unattended, and a Sunday morning is the worst
possible time to discover a broken update. So the update story is deliberately
boring: **every launch is an update opportunity, and a failed update just runs
the version that was already working.**

### How it works

The LaunchAgent runs `proclaim_service_launch.sh`, which on every start:

1. Fetches `origin/proclaim-stable` (bounded by a timeout — a dead network can't
   wedge the launch).
2. Checks out and fast-forwards to it.
3. Runs `uv sync` if the SHA changed, so new dependencies ride along.
4. Starts the service — **unconditionally**, whatever happened above.

Because `KeepAlive` is on, every crash restart, reboot, and midnight document
roll re-runs that sequence.

Failure modes, all of which end with the service running:

| What went wrong | What happens |
|---|---|
| Network/remote unreachable | Fetch fails, previous version runs |
| Uncommitted local edits in the checkout | Checkout fails, edits kept, previous version runs |
| Local commits on `proclaim-stable` | Fast-forward refused, previous version runs |
| New version's dependencies won't install | Checkout rolls back to the previous SHA, that version runs |
| `git` missing entirely | Update skipped, service runs |

### Releasing

`proclaim-stable` is the release channel *and* the Sunday-freeze mechanism, in
one primitive. Promotion is a deliberate act:

```bash
git push origin main:proclaim-stable
```

Don't move the branch after Thursday — an installed service picks up whatever
the branch points at the next time it restarts, and nobody wants to debug that
at 9:45 on Sunday.

To roll a bad release back, move the branch to a known-good commit and restart
the service:

```bash
git push --force-with-lease origin <good-sha>:proclaim-stable
```

### Applying an update

Restarting the service *is* updating it:

```bash
launchctl stop org.kenarnold.proclaim-service   # KeepAlive restarts it, updating on the way up
```

### Checking which version is running

The service reports its SHA, branch, and update channel into the session doc's
`status` map, so the session status page (`/status`) shows the running version
and flags **"Update pending — restart the service"** when `proclaim-stable` has
moved past it. The same information is in the log at startup:

```bash
grep -E 'proclaim-launcher|Version:' ~/Library/Logs/proclaim-service/stdout.log | tail
```

### Turning updates off

Either install with `--no-auto-update`, or set `PROCLAIM_AUTO_UPDATE` to `0` in
the plist's `EnvironmentVariables` and reload. The service then runs whatever is
checked out, exactly as it did before auto-update existed.

### Developing on a machine that also runs the service

The wrapper only moves the checkout **it lives in** (it resolves the repo from
its own path), and only when something runs it. Normal development is untouched:

```bash
uv run proclaim_service.py       # never touches git — no wrapper involved
uv run pytest                    # likewise
```

It also won't destroy uncommitted work: with a dirty tree the checkout is
refused, your edits stay, and the previous version runs. But a **clean** tree on
a feature branch *will* be switched to `proclaim-stable` the next time launchd
restarts the service — quietly, in the background. So don't point an
auto-updating LaunchAgent at the checkout you develop in. Either:

```bash
bash install_proclaim_service.sh --no-auto-update        # freeze this install
bash install_proclaim_service.sh --branch=my-feature     # or track your own branch
```

or keep a separate clone for the installed service.

### Testing the wrapper itself

The automated version needs no Proclaim, no network, and no real `uv`:

```bash
uv run pytest tests/test_proclaim_launcher.py
```

Those tests build a throwaway remote and checkout, then break the update every
way that matters (unreachable remote, hung fetch, local edits, failed dependency
sync) and assert the service still started.

To watch it by hand without touching your working repo, clone it into a scratch
directory and drive that clone. `UV_BIN=/bin/echo` turns the final `exec` into a
dry run that prints what *would* have started:

```bash
git clone --bare . /tmp/proclaim-origin.git
git -C /tmp/proclaim-origin.git branch -f proclaim-stable HEAD~1   # a "release"
git clone /tmp/proclaim-origin.git /tmp/proclaim-test

UV_BIN=/bin/echo bash /tmp/proclaim-test/proclaim_service_launch.sh
# ... updated proclaim-stable: d298ed4 -> beb4fbb
# ... starting proclaim service (beb4fbb on proclaim-stable)
```

Move `/tmp/proclaim-origin.git`'s `proclaim-stable` around and re-run to
rehearse promotions and rollbacks; add an uncommitted edit in
`/tmp/proclaim-test` to watch the update decline and run the old version.

## Management

### Check service status

```bash
launchctl list | grep proclaim-service
```

You should see output like:
```
- 0 org.kenarnold.proclaim-service
```

The first number is the PID (- means not running). The 0 is the exit code.

### View logs

```bash
# Real-time log viewing
tail -f ~/Library/Logs/proclaim-service/proclaim_service.log
tail -f ~/Library/Logs/proclaim-service/stdout.log
tail -f ~/Library/Logs/proclaim-service/stderr.log

# Or view all together
tail -f ~/Library/Logs/proclaim-service/*.log
```

### Stop the service

```bash
launchctl stop org.kenarnold.proclaim-service
```

### Restart the service

```bash
launchctl stop org.kenarnold.proclaim-service
launchctl start org.kenarnold.proclaim-service
```

### Unload the service (disable auto-start)

```bash
bash install_proclaim_service.sh --uninstall
```

Or manually:

```bash
launchctl unload ~/Library/LaunchAgents/org.kenarnold.proclaim-service.plist
```

### Re-enable the service

```bash
bash install_proclaim_service.sh
```

## Date Change Handling

The service automatically handles midnight rollovers:

1. **Service startup**: When using default doc ID (not specified via `PROCLAIM_DOC_ID`), service generates `doc-{today's-date}`
2. **Periodic check**: Service checks the date on each poll cycle
3. **On date change**: Service detects the date has changed and exits cleanly
4. **launchd restart**: Automatically restarts the service (respecting the 5-second throttle interval)
5. **New document**: Service generates new doc ID for today's date (e.g., `doc-2024-12-09`)

No manual intervention needed! The service runs seamlessly across midnight transitions.

## Restart Behavior

- **On exit or crash**: Service restarts automatically (no spam due to `ThrottleInterval: 5`)
- **On date change**: Service exits cleanly → launchd waits 5 seconds → restarts with new date
- **On system reboot**: Service starts automatically on login

## Environment Variables

To customize Proclaim or Y-Sweet URLs, edit the plist in LaunchAgents:

```bash
open ~/Library/LaunchAgents/org.kenarnold.proclaim-service.plist
```

Or use a text editor:

```bash
nano ~/Library/LaunchAgents/org.kenarnold.proclaim-service.plist
```

Find the `EnvironmentVariables` section and uncomment/update the URLs you need:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>YSWEET_URL</key>
    <string>http://your-ysweet-url.com</string>
    <key>PROCLAIM_BASE_URL</key>
    <string>http://your-proclaim-url:52195</string>
    <key>PROCLAIM_WRITE_KEY</key>
    <string>the-shared-write-key</string>
</dict>
```

Then reload the service:

```bash
launchctl stop org.kenarnold.proclaim-service
launchctl start org.kenarnold.proclaim-service
```

## Troubleshooting

### Service won't start

Check the logs:
```bash
cat ~/Library/Logs/proclaim-service/stderr.log
```

Common issues:
- Path to wrapper script is incorrect
- Python/uv is not in PATH (`UV_BIN` in the plist's EnvironmentVariables)
- Proclaim or Y-Sweet is not running

### Updates aren't being picked up

The wrapper logs every update decision to `stdout.log` with a
`proclaim-launcher` tag:

```bash
grep proclaim-launcher ~/Library/Logs/proclaim-service/stdout.log | tail
```

Look for `running the current version` (the update was skipped and why) or
`rolling back` (the new version's dependencies wouldn't install). A checkout with
uncommitted local edits will never update until they're stashed or committed.

### Service keeps restarting

Check if there's a genuine error in logs. If it's failing rapidly (less than 5 seconds), the throttle interval will slow it down. Adjust `ThrottleInterval` if needed (increase for longer delays between restarts).

### Force restart to change documents

If you need to manually restart and switch to a different document:

```bash
launchctl restart org.kenarnold.proclaim-service
```

Or use the installer:

```bash
bash install_proclaim_service.sh --uninstall
bash install_proclaim_service.sh
```

## Manual Testing

To test without installing as a service:

```bash
cd /path/to/live-outline
uv run proclaim_service.py
```

This runs the service in the foreground so you can see logs directly.
