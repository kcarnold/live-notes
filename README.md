# To set up

- Copy `template-.env` to `.env`
- Get a [y-sweet account](https://jamsocket.com/) (free is fine). Put the connection string in `.env` as `YSWEET_CONNECTION_STRING`.
- Get a Gemini API key and add it to `.env` as `GEMINI_API_KEY`.
- Get an ElevenLabs API key and add it to `.env` as `ELEVENLABS_API_KEY`.
- Run `npm install` to install packages.

## To run

Backend:

```
npm run dev:server
```

Frontend:

```
npm run dev
```

## Testing & Building

```bash
# Run tests
npm test

# Lint code
npm run lint

# Build for production
npm run build

# Start production server (serves built files)
npm start
```

## Deployment

### Local dev with Docker

```bash
# Auto-merges compose.yaml + compose.override.yaml (uses localhost URLs)
docker compose up -d
```

### Production

```bash
# On the server
./deploy.sh
```

`deploy.sh` runs `git pull`, builds, and starts with `compose.prod.yaml` (sets the public y-sweet URL).

### Other commands

```bash
# View logs
docker compose logs -f

# Stop
docker compose down
```

Environment variables are loaded from `.env` automatically.

## Project Details

This is a live translation application for presentations/talks. It provides:
- Real-time speech transcription (Web Speech API)
- AI-powered translation (Google Gemini)
- Text-to-speech output (ElevenLabs)
- Collaborative editing (Y-Sweet/Yjs)
- Multiple layout configurations

See [CLAUDE.md](CLAUDE.md) for detailed architecture and development information.
