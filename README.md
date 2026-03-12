# Video Content Automation Platform

Platform for video analysis and social media content creation.

## Stack

- **Frontend**: Vite, React, TypeScript, Shadcn UI
- **Backend**: Node.js, Fastify, Drizzle ORM, Lucia Auth
- **Database**: PostgreSQL, Redis (Docker)

## Setup

**Prerequisites:** Docker Desktop, Node.js 20+

1. First time only — copy `.env.example` to `.env` and fill in your Cloudflare R2 credentials (see [docs/CLOUDFLARE_R2_SETUP.md](./docs/CLOUDFLARE_R2_SETUP.md)):
   ```bash
   cp .env.example .env
   # Edit .env with your R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT
   ```

2. Start everything with one command:
   ```bash
   npm run dev
   ```
   This will:
   - Start Docker (Postgres, Redis, screencast-worker)
   - Wait for Redis to be ready
   - Apply the database schema
   - Start backend (port 3001 by default) and frontend (port 5173)

3. Open http://localhost:5173 (or 5174)

**Port conflicts?** This project uses non-standard ports by default (Postgres 5433, Redis 6380, Backend 3001) to avoid conflicts with other projects. Override in `.env` with `POSTGRES_PORT`, `REDIS_PORT`, `PORT` if needed.

## Run Locally in Docker (Production-like)

To test the same stack that runs on the VPS (Backend, Frontend, Postgres, Redis, Traefik — no screencast worker):

```bash
npm run docker:prod
```

This builds images, runs migrations, and starts the stack. Open **http://localhost** (port 80). If port 80 is in use, set `PORT_HTTP=8080` in `.env` and use http://localhost:8080.

To stop: `docker compose -f docker-compose.prod.yml down`

## Screencast Recording (Add Video by URL)

When you add a video by pasting a replay URL, the system records the screen and audio from that page:

- **Backend** enqueues a job in BullMQ and returns immediately
- **Screencast worker** (runs in Docker) opens the URL in Chromium, records with FFmpeg + PulseAudio, uploads to R2

The screencast worker runs automatically when you use `npm run dev`. It reads R2 credentials from the root `.env` file.

**Recording strategies:**
- **`docker`**: Uses Xvfb + PulseAudio + FFmpeg x11grab. Runs in Docker, suitable for server deployment.
- **`puppeteer-stream`** (default): Uses Chrome's internal streaming API. Works on macOS/Windows without Docker. The browser opens off-screen (`--window-position=9999,9999`) so it does not steal focus or expand to fullscreen. On Linux, use `Xvfb :99 -screen 0 1920x1080x24 &` and `DISPLAY=:99` for a fully invisible browser (like Docker).

For **live preview** (the image you see while recording is what the worker is actually capturing), set `BACKEND_URL` and `SCREENCAST_PREVIEW_SECRET` in `.env`. Use the same secret value so the worker can send frames to the backend; e.g. `BACKEND_URL=http://host.docker.internal:3001` and any random string for `SCREENCAST_PREVIEW_SECRET`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The project is conducted entirely in English (code, comments, UI).

## Storage (Cloudflare R2)

For S3-compatible object storage, see [docs/CLOUDFLARE_R2_SETUP.md](./docs/CLOUDFLARE_R2_SETUP.md) for credentials and setup.

## Credentials

There are no default credentials. Go to `/register` to create an account, then sign in with your email and password.
