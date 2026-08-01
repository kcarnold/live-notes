# Proclaim Integration

This integration syncs current slide text from Proclaim to the live-notes application in real-time.

## Architecture

The integration uses **Yjs** for real-time synchronization:

1. **Python Service** (`proclaim_service.py`) - Runs on the computer with Proclaim
   - Polls Proclaim API for current presentation and slide status
   - Parses presentation content from the Proclaim database
   - Updates Yjs shared state via Y-Sweet WebSocket connection
   - Internally decoupled into a **slide feed** (`proclaim_feed.py`, the source) and
     **consumers** (`yjs_publisher.py` for clients, `slide_translator.py` for translation),
     wired by `slide_sync_runtime.py`. `proclaim_service.py` is just the entrypoint. The feed
     emits a serializable snapshot per poll — the seam a future replay harness records.

2. **Yjs Shared State**
   - `proclaimPresentations` (Y.Map) - Maps itemId → presentation data
     - Each presentation contains: `{title: string, itemId: string, slides: Y.Array<string>}`
   - `proclaimStatus` (Y.Map) - Current status: `{itemId: string, slideIndex: number}`

3. **React Components** (`CurrentSlideViewer.tsx`)
   - **Container**: Reads from Yjs and extracts presentation data
   - **Pure component**: Displays current slide with context (prev/next slides)
   - Real-time updates via Yjs (no polling needed)

## Setup

### 1. Install Python Dependencies

On the computer running Proclaim:

```bash
# Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
uv sync
```

### 2. Run the Proclaim Service

```bash
# Make sure Proclaim is running
# Start the service. By default it targets doc-YYYY-MM-DD using the on-air show's
# scheduled date (Proclaim's DateGiven), falling back to today's date if the show
# has no date. This means you can pre-stage a future-dated show: bring it on air in
# Proclaim and the service syncs to that date's doc automatically.
uv run proclaim_service.py

# Or specify a custom doc ID (disables date-based selection entirely)
uv run proclaim_service.py my-custom-doc
```

Environment variables:
- `PROCLAIM_BASE_URL` - Proclaim API URL (default: `http://localhost:52195`)
- `YSWEET_URL` - Express server URL (default: `http://localhost:8000`)
- `PROCLAIM_POLL_INTERVAL` - Polling interval in seconds while on air (default: `0.5`)
- `PROCLAIM_POLL_INTERVAL_OFF_AIR` - Polling interval while off air (default: `10`)
- `PROCLAIM_DOC_ID` - Document ID (overridden by command line arg)

Connection robustness tuning (rarely need changing):
- `PROCLAIM_OFF_AIR_DISCONNECT_AFTER` - Seconds off air before dropping the Y-Sweet connection (default: `60`)
- `PROCLAIM_RECONNECT_BACKOFF_INITIAL` / `PROCLAIM_RECONNECT_BACKOFF_MAX` - Exponential backoff bounds for reconnect attempts in seconds (default: `1.0` / `30.0`)
- `PROCLAIM_WS_PING_INTERVAL` - Y-Sweet websocket keepalive ping interval in seconds (default: `15`)
- `PROCLAIM_YSWEET_TOKEN_TIMEOUT` - Timeout in seconds for fetching a Y-Sweet token, so a cold server fails into retry rather than hanging (default: `30`)

### Connection lifecycle & resilience

The service is designed to survive a Y-Sweet server that scales to zero and slow/cold
reconnects:

- **No connection until on air.** While Proclaim is off air the service only polls the
  local Proclaim API; it holds no Y-Sweet connection. It connects the moment Proclaim
  goes on air.
- **Disconnect when idle.** After `PROCLAIM_OFF_AIR_DISCONNECT_AFTER` seconds off air it
  drops the Y-Sweet connection (a short grace period avoids churn when switching between
  presentations) and goes back to waiting.
- **Automatic reconnect with backoff.** Any connection failure - a cold/slow token
  fetch, a failed websocket upgrade, or a mid-session drop - is retried with exponential
  backoff instead of killing the service. On (re)connect the current presentation and
  slide are re-pushed so a freshly woken server gets the latest state.
- **Active health checks.** The service pings the websocket each poll so a silently
  dropped connection is detected promptly and triggers a reconnect (the underlying
  library otherwise swallows the disconnect).
- **Show-dated documents.** When using the default date-based doc, the service anchors
  the doc to the on-air show's scheduled date (Proclaim's `DateGiven`), so a show
  prepared the night before still syncs to its own date's doc. When a show has no usable
  date it falls back to today's date and rolls over at midnight (with a fresh doc) without
  needing an external restart.

### 3. View Current Slide in Browser

Navigate to a layout that includes `currentSlide`:

```
http://localhost:8000/currentSlide
http://localhost:8000/translatedText-French,currentSlide
```

## How It Works

### 1. Python Service Polls Proclaim

Every second (configurable):
- Fetches `/onair/session` to get session ID
- Fetches `/onair/statusChanged` to get current slide index and item ID

### 2. Presentation Changes → Update Yjs

When a new presentation is detected:
- Queries Proclaim SQLite database for service item content
- Parses rich text XML to extract slide text
- Decodes the custom order sequence to get slides in correct order
- Stores full presentation in `proclaimPresentations` Yjs map
- Updates `proclaimStatus` with current itemId and slideIndex
- Sends update to Y-Sweet WebSocket

### 3. Slide Changes → Update Yjs

When the slide index changes:
- Updates `proclaimStatus` in Yjs
- Sends update to Y-Sweet WebSocket

### 4. Browser Auto-Updates

React component:
- Subscribes to Yjs changes via `useMap()`
- Extracts current presentation and slide index
- Renders current slide with context (previous and next slides)
- Updates automatically when Yjs changes (no polling!)

## UI Features

The current slide viewer shows:
- **Header**: Title and progress (slide X of Y)
- **Current slide**: Large, highlighted with blue border
- **Context slides**: Previous and next slides (dimmed, smaller text)
- **Smooth transitions**: CSS animations when slides change

## Data Flow

```
Proclaim API/DB
    ↓ (poll every 1s)
Python Service
    ↓ (y-py WebSocket)
Y-Sweet Server
    ↓ (Yjs sync)
React Component
    ↓ (render)
Browser Display
```

No HTTP polling from browser → instant updates!

## Auto-Update Mechanism

The macOS LaunchAgent runs `proclaim_service_launch.sh`, which updates the
checkout from the `proclaim-stable` release branch on every launch and then
starts the service whether or not the update worked (a failed dependency sync
rolls back to the SHA that was running). Releasing is
`git push origin main:proclaim-stable`; applying a release is restarting the
service. See [PROCLAIM_SERVICE_SETUP.md](PROCLAIM_SERVICE_SETUP.md#automatic-updates).

On Linux the equivalent is a systemd unit that runs the same wrapper:

```ini
# /etc/systemd/system/proclaim-sync.service
[Unit]
Description=Proclaim Sync Service
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/live-notes
Environment=UV_BIN=/usr/local/bin/uv
ExecStart=/bin/bash /path/to/live-notes/proclaim_service_launch.sh
Restart=always

[Install]
WantedBy=multi-user.target
```

