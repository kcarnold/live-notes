# Proclaim Integration

This integration syncs current slide text from Proclaim to the live-notes application.

## Architecture

The integration consists of three parts:

1. **Python Service** (`proclaim_service.py`) - Runs on the computer with Proclaim
   - Polls Proclaim API for current presentation and slide status
   - Parses presentation content from the Proclaim database
   - POSTs updates to the Express server

2. **Express Endpoints** (in `server.ts`)
   - `/api/proclaim/update` - Receives updates from Python service
   - `/api/proclaim/state/:docId` - Serves current state to clients

3. **React Component** (`CurrentSlideViewer.tsx`)
   - Displays current slide text in the browser
   - Polls the Express endpoint for updates
   - Renders slide text with formatting

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

1. **Proclaim Service** polls Proclaim API every second:
   - Fetches `/onair/session` to get session ID
   - Fetches `/onair/statusChanged` to get current slide index and item ID

2. When presentation or slide changes:
   - Queries Proclaim SQLite database for service item content
   - Parses rich text XML to extract slide text
   - Decodes the custom order sequence to get slides in correct order
   - POSTs to Express server with presentation and status data

3. **Express Server** stores current state in memory:
   - Updates a Map keyed by docId
   - Serves state via `/api/proclaim/state/:docId`

4. **React Component** polls Express server:
   - Fetches state every second
   - Renders current slide with title and progress indicator

## Future Enhancements

### Proper Yjs Integration

Currently, the integration uses in-memory state in Express. For production:

1. Use `y-py` (Python Yjs bindings) in the Proclaim service
2. Connect to Y-Sweet WebSocket server
3. Update a shared Y.Array with presentation slides
4. React component reads directly from Yjs (real-time updates)

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

**Option 3: Watch for changes**
Use a tool like `watchexec` or `entr` to restart on git updates.

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

## Troubleshooting

**Service won't connect to Proclaim:**
- Check that Proclaim is running
- Verify Proclaim API is accessible: `curl http://localhost:52195/onair/session`
- Check firewall settings

**No slides appearing in browser:**
- Check Express server logs for incoming updates
- Verify browser is polling the correct docId
- Check network tab for `/api/proclaim/state/:docId` requests

**Database not found:**
- Verify Proclaim data directory exists
- Check permissions on the database file
- Try manually specifying the database path

**Slides in wrong order:**
- Check `CustomOrderSequence` in Proclaim
- Verify the order parsing logic handles your presentation format
- Check service logs for warnings about missing labels
