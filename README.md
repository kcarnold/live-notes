# To set up

- Copy `template-.env` to `.env`
- Get a [y-sweet account](https://jamsocket.com/) (free is fine). Put the connection string in `.env` as `YSWEET_CONNECTION_STRING`.
- Get a Gemini API key and add it to `.env` as `GEMINI_API_KEY`.
- Set up Google Cloud Text-to-Speech:
  - Create a Google Cloud project and enable the Text-to-Speech API
  - Create a service account and download the JSON key file
  - Set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to point to the key file path
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

```bash
# Build and run with Docker Compose
docker compose build
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

**Note**: The application uses `compose.yaml`. Environment variables are loaded from `.env` automatically.

## Project Details

This is a live translation application for presentations/talks. It provides:
- Real-time speech transcription (Web Speech API)
- AI-powered translation (Google Gemini)
- Text-to-speech output (Google Cloud Text-to-Speech with Chirp 3 HD voices)
- Collaborative editing (Y-Sweet/Yjs)
- Multiple layout configurations

See [CLAUDE.md](CLAUDE.md) for detailed architecture and development information.
