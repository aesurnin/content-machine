# Troubleshooting

## How Data Is Stored (Dev vs Docker)

Projects, videos, and users live in **PostgreSQL**. Both setups use the same volume:

| Mode | Postgres | Volume |
|------|----------|--------|
| `npm run dev` | docker-compose.yml (port 5433) | `online-game-commenter_postgres_data` |
| `npm run docker:prod` | docker-compose.prod.yml | `online-game-commenter_postgres_data` |

**Same volume** → your projects from local dev should appear in Docker prod and vice versa.

**To switch modes:**
1. Stop the current stack: `docker compose down` (or `docker compose -f docker-compose.prod.yml down`)
2. Start the other: `npm run dev` or `npm run docker:prod`

If you don't see your projects, ensure you're not running two Postgres instances at once. Run `docker ps` and stop any extra postgres containers.

---

## Quick Checklist

### 1. `.env` file exists and has required vars

```bash
# From project root
test -f .env && echo "OK: .env exists" || echo "MISSING: Copy .env.example to .env"
grep -E "^(AUTH_USERS|R2_|DATABASE)" .env 2>/dev/null | head -5
```

**Required:**
- `AUTH_USERS=email:password` — login credentials (e.g. `admin@example.com:mypassword`)
- `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — Cloudflare R2 (backend won't start without these)

### 2. Docker stack is running

```bash
docker compose -f docker-compose.prod.yml ps
```

All services (postgres, redis, backend, frontend, traefik) should be "Up".

### 3. Backend responds

```bash
curl -s http://localhost/api/ping
# Expected: {"pong":"it works!"}
```

If 404 or connection refused — Traefik or backend issue.

### 4. Can't log in

- **No users:** Set `AUTH_USERS=your@email.com:yourpassword` in `.env`, then restart backend:
  ```bash
  docker compose -f docker-compose.prod.yml restart backend
  ```
- **Wrong password (local):** `cd apps/backend && npx tsx scripts/reset-password.ts your@email.com newpassword`
- **Wrong password (server):** Delete user, set new password in `.env` (AUTH_USERS), restart backend:
  ```bash
  docker compose -f docker-compose.prod.yml exec postgres psql -U user -d videoplatform -c "DELETE FROM \"user\" WHERE email='your@email.com'"
  ```
  Set `AUTH_USERS=your@email.com:newpassword` in `.env`, then `docker compose -f docker-compose.prod.yml up -d backend --force-recreate`. Seed will create the user.

### 5. Backend exits immediately (R2 error)

```
Fatal: R2 storage is required. Set R2_BUCKET_NAME, R2_ENDPOINT...
```

Add R2 credentials to `.env`. See [CLOUDFLARE_R2_SETUP.md](./CLOUDFLARE_R2_SETUP.md).

### 6. Running `npm run dev` (not Docker)?

- Backend: port 3001
- Frontend: port 5173, proxies `/api` → backend
- Ensure `AUTH_USERS` and R2 vars are in root `.env` (or `apps/backend/.env`)

---

## Common Errors

| Symptom | Fix |
|---------|-----|
| Blank page at localhost | Check browser console; `/api` may be 404 — ensure Traefik + backend are up |
| "Failed to fetch" / network error | Backend not running or wrong URL |
| Login form does nothing | Check Network tab; backend may return 500 — check backend logs: `docker compose -f docker-compose.prod.yml logs backend` |
| Backend container keeps restarting | Usually R2 not configured or DB connection failed — `docker compose logs backend` |
