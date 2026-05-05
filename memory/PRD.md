# Tolaria — Local-First Cloud-Synced Web App

## Original Problem Statement
Make Tolaria (a Tauri v2 desktop app) work as a local-first, cloud-synced web app accessible from anywhere.

## User Requirements
- "Local-first" = works offline, syncs when online
- Target user: Single user
- Sync strategy: Conflict resolution
- Sync scope: Everything

## Architecture

### Current Stack
```
Browser → Nginx
├── /api/*    → FastAPI backend (port 8001)  — /app/backend/server.py
└── /*        → Static React build (port 3000) — serve /app/dist
```

### Cloud Storage Layout
```
/app/vault_store/
  {vault_id}/          ← server-managed vault files (cloud storage)
    note1.md
    note2.md

MongoDB: tolaria_sync.vault_files
  { vault_id, filename, storage_path, content_hash,
    content_size, modified_at, synced_at, deleted }
```

### Key Files
- `/app/src/vault-api.ts` — proxy layer routing commands to /api/vault/*
- `/app/src/mock-tauri/mock-handlers.ts` — mock data fallback
- `/app/src/hooks/useCloudSync.ts` — cloud sync polling hook (NEW)
- `/app/src/App.tsx` — wires useCloudSync alongside useAutoSync (git sync)
- `/app/backend/server.py` — FastAPI: vault CRUD + sync endpoints
- `/app/backend/.env` — MONGO_URL, DB_NAME
- `/app/frontend/package.json` — launcher: `npx serve -s /app/dist -l 3000`
- `/app/vite.config.ts` — __DEMO_VAULT_PATH__ = /app/vault_store/default
- `/app/vault_store/` — cloud vault storage root
- `/Users/mock/demo-vault-v2` → symlink to `/app/demo-vault-v2`

## API Endpoints

### Vault CRUD (Phase 1 — all working ✅)
- `GET  /api/vault/ping`
- `GET  /api/vault/list?path=`
- `GET  /api/vault/entry?path=`
- `GET  /api/vault/content?path=`
- `GET  /api/vault/all-content?path=`
- `GET  /api/vault/search?vault_path=&query=`
- `POST /api/vault/save`         ← auto-tracks MongoDB when path is in vault_store
- `POST /api/vault/rename`
- `POST /api/vault/rename-filename`
- `POST /api/vault/move-to-folder`
- `POST /api/vault/delete`       ← auto-marks deleted in MongoDB

### Cloud Sync (Phase 2 — all working ✅)
- `POST /api/vault/sync/init`    — seed cloud vault from any local path
- `POST /api/vault/sync/push`    — push changes with conflict detection
- `GET  /api/vault/sync/pull?vault_id=&since=` — incremental pull
- `GET  /api/vault/sync/status?vault_id=`      — stats

## Implementation Status

### Phase 1 — Browser Mode (COMPLETE ✅) — 2026-05-05
- App runs in browser without Tauri
- FastAPI backend serves /api/vault/* endpoints
- 31 real notes from demo-vault-v2, CRUD works
- Frontend built and served statically

### Phase 2 — Cloud Backend + Sync POC (COMPLETE ✅) — 2026-05-05
- MongoDB integration (motor async)
- Cloud vault storage at /app/vault_store/
- sync/init, sync/push, sync/pull, sync/status all working
- Conflict detection on push (stale writes rejected)
- No frontend changes needed for Phase 2 core

### P0 — Cloud Vault as Default Path (COMPLETE ✅) — 2026-05-05
- __DEMO_VAULT_PATH__ → /app/vault_store/default in vite.config.ts
- App now loads cloud vault by default
- Frontend rebuilt, verified in browser: 31 notes from cloud storage

### P1 — Sync Loop (COMPLETE ✅) — 2026-05-05
- useCloudSync.ts hook: polls /api/vault/sync/pull every 30s
- On remote changes → calls vault.reloadVault() to refresh notes
- Auto-tracks every /api/vault/save to MongoDB (delta sync works)
- Auto-marks deletes as tombstones in MongoDB
- Wired into App.tsx alongside existing useAutoSync (git sync)
- E2E validated: Session A save → Session B pull returns change in <1s

## Bugs Fixed — 2026-05-05

### Bug: 9k+ mock notes shown on page reload
- **Root cause**: `vault-api.ts` fired N concurrent pings on startup with only 500ms timeout.
  On a fresh browser load (DNS + TLS + nginx overhead), some pings timed out → `vaultApiAvailable = false`
  → app fell back to `MOCK_ENTRIES` (40 real + 9000 generated entries).
- **Fix**: Increased timeout 500ms → 3000ms; deduplicated concurrent pings with a shared Promise
  (all concurrent callers share one in-flight ping, not N parallel pings).
- **File**: `/app/src/mock-tauri/vault-api.ts`

### Bug: Created notes disappear after reload
- **Root cause**: Same root cause as above. When vault-api failed, the app used mock handlers.
  After reload, mock fallback returned 9k+ entries hiding any real filesystem changes.
- **Fix**: Same fix as above — vault-api now reliably detects on startup every time.


- P1: Auth (JWT, single user) before exposing to real internet
- P1: Persist vault path selection per user in MongoDB
- P2: Conflict resolution UI (show diff, let user pick version)
- P2: Incremental delta sync (only changed bytes)
- P2: PWA / service worker for true offline-first
- P2: Version history (git-based or append-only log)
- P2: Vault selection UI (multiple named vaults)

## Build Notes
- pnpm v10.33.3 installed globally
- Build: `NODE_OPTIONS="--max-old-space-size=4096" node_modules/.bin/vite build`
- sysctl inotify too low for vite dev server — production build only
- WEB_VAULT_PATH env var overrides default vault_store path at build time
- Symlink: /Users/mock/demo-vault-v2 → /app/demo-vault-v2
- MongoDB: tolaria_sync db, vault_files collection
