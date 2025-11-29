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

### Speech Transcription Automation

The Web Speech API requires a browser context with user permission. Options:

**Option 1: Keep current web-based approach**
- Manual start in browser
- Simple but requires user interaction

**Option 2: Electron app**
- Bundles both Proclaim sync AND speech transcription
- Can auto-start on login
- Full access to browser APIs

**Option 3: Tauri app**
- Lighter weight alternative to Electron
- Rust + WebView
- Can auto-start on login

**Option 4: Different STT service**
- Use Google Cloud Speech-to-Text, OpenAI Whisper, etc.
- Capture system audio from Python
- No browser permission required
- Costs money (API usage)

## Development

### Testing Without Proclaim

Mock the Proclaim API:

```python
# mock_proclaim.py
from flask import Flask, jsonify
app = Flask(__name__)

@app.route('/onair/session')
def session():
    return 'test-session-123'

@app.route('/onair/statusChanged')
def status():
    return jsonify({
        'status': {
            'itemId': 'test-item-123',
            'slideIndex': 0
        }
    })

if __name__ == '__main__':
    app.run(port=52195)
```

### Debugging

Enable debug logging:
```python
logging.basicConfig(level=logging.DEBUG)
```

Inspect Proclaim database:
```bash
sqlite3 ~/Library/Application\ Support/Proclaim/Data/*/PresentationManager/PresentationManager.db
.schema ServiceItems
SELECT * FROM ServiceItems LIMIT 5;
```

Inspect Yjs state in browser console:
```javascript
// Access Yjs doc (exposed in App.tsx for debugging)
const proclaimPresentations = window.ydoc.getMap('proclaimPresentations')
const proclaimStatus = window.ydoc.getMap('proclaimStatus')

// See current status
proclaimStatus.toJSON()

// See all presentations
proclaimPresentations.toJSON()
```

## Troubleshooting

**Service won't connect to Proclaim:**
- Check that Proclaim is running
- Verify Proclaim API is accessible: `curl http://localhost:52195/onair/session`
- Check firewall settings

**Service won't connect to Y-Sweet:**
- Check Express server is running: `curl http://localhost:8000/api/ys-auth -X POST -H "Content-Type: application/json" -d '{"docId": "test", "isEditor": true}'`
- Check Y-Sweet connection string in `.env`
- Check network connectivity

**No slides appearing in browser:**
- Check browser console for Yjs connection errors
- Verify Python service is connected: check logs for "Connected to Y-Sweet"
- Inspect Yjs state in browser console (see Debugging section)

**Database not found:**
- Verify Proclaim data directory exists
- Check permissions on the database file
- Try manually specifying the database path

**Slides in wrong order:**
- Check `CustomOrderSequence` in Proclaim
- Verify the order parsing logic handles your presentation format
- Check service logs for warnings about missing labels

**WebSocket connection issues:**
- Check Y-Sweet server logs
- Verify no proxy/firewall is blocking WebSocket connections
- Try increasing POLL_INTERVAL to reduce load
