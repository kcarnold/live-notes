# Running Proclaim Service as a macOS Service

This guide explains how to run `proclaim_service.py` as a persistent background service on macOS with auto-restart and date-change handling.

## Overview

The setup includes:
- **Wrapper script** (`proclaim_wrapper.sh`): Simple script that runs the service and logs output
- **Service logic** (`proclaim_service.py`): Detects date changes and exits cleanly for restart
- **Plist template** (`org.kenarnold.proclaim-service.plist.template`): Template that gets customized during installation
- **Install script** (`install_proclaim_service.sh`): Generates the plist with your paths and user, then installs it
- **Log directory**: Logs stored at `~/Library/Logs/proclaim-service/`

The setup is portable—works with any user and any repo location.

## Installation

The install script automatically generates the plist from a template with your current paths and user, so it's portable across different systems.

### Run the installer

```bash
bash install_proclaim_service.sh
```

That's it! The installer will:
- ✓ Generate the plist from the template with your current user, paths, and log directory
- ✓ Create the log directory
- ✓ Install the plist to `~/Library/LaunchAgents/`
- ✓ Load the service

The service should now start automatically and restart on reboot.

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
- Python/uv is not in PATH (add to EnvironmentVariables)
- Proclaim or Y-Sweet is not running

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
bash /Users/ka37/code/github.com/kcarnold/live-outline/proclaim_wrapper.sh
```

This runs the service in the foreground so you can see logs directly.
