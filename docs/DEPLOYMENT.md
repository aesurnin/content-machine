# Production Deployment Guide

This guide covers deploying the Video Content Automation Platform to a VPS with Docker Compose and GitHub Actions auto-deploy. The **screencast worker is not deployed**; only Backend API, Frontend, PostgreSQL, Redis, and Traefik reverse proxy run in production.

## Hetzner Cloud Setup

1. **Create a project** at [console.hetzner.cloud](https://console.hetzner.cloud)
2. **Add SSH key**: Security → SSH Keys → Add your public key
3. **Create server**: Add Server → Cloud Server
   - **Location**: Falkenstein or Nuremberg
   - **Image**: Ubuntu 24.04
   - **Type**: CPX21 (4 vCPU, 4GB RAM) or CPX31 (4 vCPU, 8GB RAM) for workflow rendering
   - **SSH key**: Select your key
   - **Firewall**: Optional — allow SSH (22), HTTP (80), HTTPS (443)
4. **Note the IP** — you'll use it for `SSH_HOST` and for your domain's A record

## Local Testing (Same as VPS)

Before deploying, run the full stack locally in Docker to verify everything works:

```bash
npm run docker:prod
```

Open http://localhost. This uses the same `docker-compose.prod.yml` and images as the VPS. If it works locally, it will work on the server.

## Prerequisites

- **VPS**: Ubuntu 22.04 or 24.04, minimum 2GB RAM (4GB recommended for workflow rendering). Hetzner CPX21 (4GB) or CPX31 (8GB) works well.
- **Domain**: Point your domain's A record to the VPS IP
- **GitHub repo**: Code pushed to `main` branch

## 1. Server Setup (One-Time)

### Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group to take effect
```

Or use the setup script: `./scripts/setup-vps.sh` (run with sudo).

### Clone the Repository

```bash
cd ~
git clone https://github.com/YOUR_ORG/online-game-commenter.git
cd online-game-commenter
```

For a private repo, configure SSH keys or a deploy token so `git pull` works without prompts.

### Create `.env` File

Copy and edit the environment file:

```bash
cp .env.example .env
# Edit .env with your production values
```

**Required variables for production:**

| Variable | Description |
|----------|-------------|
| `POSTGRES_USER` | PostgreSQL username (default: `user`) |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `POSTGRES_DB` | Database name (default: `videoplatform`) |
| `AUTH_USERS` | Pre-defined users: `email1:password1,email2:password2` |
| `R2_ACCOUNT_ID` | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET_NAME` | R2 bucket name |
| `R2_ENDPOINT` | R2 endpoint URL (e.g. `https://ACCOUNT_ID.r2.cloudflarestorage.com`) |

`DATABASE_URL` and `REDIS_URL` are overridden in `docker-compose.prod.yml` to use internal Docker hostnames (`postgres`, `redis`). No need to set them in `.env` for production.

See [CLOUDFLARE_R2_SETUP.md](./CLOUDFLARE_R2_SETUP.md) for R2 credentials.

### Apply Database Schema (First Deploy Only)

Before starting the full stack, run migrations once:

```bash
# Start Postgres first
docker compose -f docker-compose.prod.yml up -d postgres

# Wait a few seconds for Postgres to be ready, then run migrations
docker compose -f docker-compose.prod.yml --profile init run --rm db-migrate
```

### Start the Stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

The app will be available at `http://YOUR_SERVER_IP`.

## 2. GitHub Actions Auto-Deploy

### Prerequisites

Ensure these files are committed to the repo:

- `docker-compose.prod.yml`
- `apps/backend/Dockerfile`, `apps/backend/Dockerfile.migrate`
- `apps/frontend/Dockerfile`

### Repository Secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Required | Description |
|--------|----------|-------------|
| `SSH_HOST` | Yes | VPS IP (e.g. `65.108.85.215`) |
| `SSH_USER` | Yes | SSH user (e.g. `root`) |
| `SSH_PRIVATE_KEY` | Yes | Full private key (PEM), including `-----BEGIN/END-----` |
| `DEPLOY_PATH` | No | Path on server (default: `/root/online-game-commenter`) |
| `GHCR_TOKEN` | Yes* | GitHub PAT with `read:packages` — server needs it to pull images |

\* GHCR packages are private by default. Create a [Fine-grained PAT](https://github.com/settings/tokens) or classic PAT with `read:packages` scope.

### Deploy Flow

On every push to `main`:

1. Build Backend and Frontend Docker images
2. Push to `ghcr.io/<owner>/<repo>/backend:latest` and `.../frontend:latest`
3. SSH to VPS → `git fetch && git reset --hard` → `docker compose pull` → `docker compose up -d`

### First-Time Setup

1. Clone repo on server: `git clone https://github.com/YOUR_ORG/online-game-commenter.git`
2. Create `.env` and `apps/backend/.env` (see "Create .env File" above)
3. Run migrations: `docker compose -f docker-compose.prod.yml --profile init run --rm db-migrate`
4. Add GitHub secrets, then push to `main` to trigger deploy

## 3. Optional: HTTPS with Let's Encrypt

To add automatic SSL, extend the Traefik service in `docker-compose.prod.yml`:

```yaml
traefik:
  image: traefik:v3.0
  command:
    - "--api.dashboard=false"
    - "--providers.docker=true"
    - "--providers.docker.exposedbydefault=false"
    - "--entrypoints.web.address=:80"
    - "--entrypoints.websecure.address=:443"
    - "--certificatesresolvers.letsencrypt.acme.email=your@email.com"
    - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
    - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - letsencrypt:/letsencrypt
  # ... rest unchanged
```

Add labels to `backend` and `frontend` for HTTPS:

```yaml
# Backend
- "traefik.http.routers.backend-secure.rule=PathPrefix(`/api`)"
- "traefik.http.routers.backend-secure.entrypoints=websecure"
- "traefik.http.routers.backend-secure.tls.certresolver=letsencrypt"
- "traefik.http.routers.backend-secure.service=backend"
- "traefik.http.routers.backend-secure.middlewares=apistrip"

# Frontend
- "traefik.http.routers.frontend-secure.rule=PathPrefix(`/`)"
- "traefik.http.routers.frontend-secure.entrypoints=websecure"
- "traefik.http.routers.frontend-secure.tls.certresolver=letsencrypt"
```

Add a volume for `letsencrypt` and ensure your domain points to the server.

## 4. Re-enabling Screencast Worker (Future)

The screencast worker is excluded from production. To re-enable:

1. Add the `screencast-worker` service from [docker-compose.yml](../docker-compose.yml) into `docker-compose.prod.yml`
2. Add a build step for `Dockerfile.worker` in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)
3. Set `BACKEND_URL` and `SCREENCAST_PREVIEW_SECRET` in the server `.env`
