# Proclaim Integration

This integration syncs current slide text from Proclaim to the live-notes application in real-time.

## Architecture

The integration uses **Yjs** for real-time synchronization:

1. **Python Service** (`proclaim_service.py`) - Runs on the computer with Proclaim
   - Polls Proclaim API for current presentation and slide status
   - Parses presentation content from the Proclaim database
   - Updates Yjs shared state via Y-Sweet WebSocket connection

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
# Start the service (default doc: doc-YYYY-MM-DD)
uv run proclaim_service.py

# Or specify a custom doc ID
uv run proclaim_service.py my-custom-doc
```

Environment variables:
- `PROCLAIM_BASE_URL` - Proclaim API URL (default: `http://localhost:52195`)
- `YSWEET_URL` - Express server URL (default: `http://localhost:8000`)
- `PROCLAIM_POLL_INTERVAL` - Polling interval in seconds (default: `1.0`)
- `PROCLAIM_DOC_ID` - Document ID (overridden by command line arg)

### 3. View Current Slide in Browser

Navigate to a layout that includes `currentSlide`:

```
http://localhost:8000/currentSlide
http://localhost:8000/translatedOutline-French,currentSlide
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

## Future Enhancements

### Auto-Update Mechanism

For keeping the Python service up to date:

**Option 1: Simple git pull script**
```bash
#!/bin/bash
cd /path/to/live-notes
git pull origin main
uv sync
```

**Option 2: systemd/launchd service** (Linux/macOS)
```ini
# /etc/systemd/system/proclaim-sync.service
[Unit]
Description=Proclaim Sync Service
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/live-notes
ExecStartPre=/usr/bin/git pull origin main
ExecStartPre=/usr/local/bin/uv sync
ExecStart=/usr/local/bin/uv run proclaim_service.py
Restart=always

[Install]
WantedBy=multi-user.target
```

