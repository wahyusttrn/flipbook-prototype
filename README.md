# Flipbook: self-photo studio prototype

Staff create a session, upload the camera photos, put them into a frame, and the
customer scans a QR code to see and download everything. Links expire after 10 days.

```
Vite + React (admin + public gallery)  ──►  Cloudflare Worker (/api/*)
                │                                    │
                └──► Supabase: auth + DB ◄───────────┤
                                Storage (photos) ◄───┘
```

- **React app** (`src/`): admin at `/admin`, customer gallery at `/s/:slug`.
- **Worker** (`worker/index.ts`): the only thing that touches the private storage bucket. Serves photos only while
  a session is valid, handles uploads, and runs a daily cron that deletes expired sessions' files.
- **Supabase**: admin login, tables and photo storage (private bucket `photos`), all from `supabase/schema.sql`.
- Image resizing and frame compositing happen **in the browser**, so no server image processing is needed.

> Working on this with an AI agent? See [`AGENTS.md`](AGENTS.md) for the full architecture and conventions.

## Requirements

- Node 22+ and **pnpm** (this repo uses pnpm only; don't use npm/npx)
- A Supabase project (free tier). A Cloudflare account is only needed to deploy; local dev runs the Worker offline.

## Setup

1. **Install**: `pnpm install`
   (`esbuild` and `workerd` build scripts are pre-approved in `pnpm-workspace.yaml`.)
2. **Supabase**
   - SQL Editor → run `supabase/schema.sql` (creates tables, access rules **and** the storage bucket; safe to re-run).
   - Authentication → Sign In / Providers → **turn off "Allow new users to sign up"**.
     Any logged-in user is treated as staff, so this matters.
   - Authentication → Users → **Add user** (email + password) for each staff member.
3. **Env**: fill in `.env` (copy of `.env.example`). One file serves both Vite and the Worker.
   Use the new `sb_publishable_…` / `sb_secret_…` keys, not the legacy anon/service_role JWTs (retired in 2027):

   | Key | Where to find it | Used by |
   | --- | --- | --- |
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` (ref is in the dashboard URL, or click **Connect**) | browser |
   | `VITE_SUPABASE_ANON_KEY` | Settings → **API Keys** → Publishable key (`sb_publishable_…`) | browser |
   | `SUPABASE_URL` | same URL again | Worker |
   | `SUPABASE_SERVICE_ROLE_KEY` | Settings → **API Keys** → Secret keys (`sb_secret_…`, click the eye to reveal) | Worker only, never exposed |
   | `ADMIN_EMAILS` | optional, comma-separated staff allowlist | Worker |

4. `pnpm dev` → open the printed URL + `/admin`.
   `GET /api/health` reports whether the Worker's env is complete.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server + Worker |
| `pnpm build` | Typecheck everything, then build client + Worker into `dist/` |
| `pnpm typecheck` | `tsc -b` over app, Worker and Vite config |
| `pnpm lint` | oxlint |
| `pnpm cf-types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` or env keys |
| `pnpm preview` | Serve the production build locally |
| `pnpm deploy` | Build and deploy to Cloudflare |

## Using it

1. **Frames**: add a frame PNG/SVG at print size with **transparent photo holes**
   (e.g. 1200×1800 for 4R, 600×1800 for a 2×6 strip). Holes are detected automatically; fine-tune numbers if needed.
   Three ready-made frames are included as one-click samples (`public/sample-frames/`): **Classic strip** (2×6, 4 photos),
   **Film 35mm** (4R, 3 photos) and **Pastel party** (4R, 6 photos).
2. **Sessions → Create** → upload photos → pick a frame, tap a slot, tap a photo → **Save framed photo**.
3. Show the QR ("Show QR to customer") or copy the link. The customer gets the framed result + all shots,
   with "Save all to phone" (share sheet) or a .zip on desktop.
4. Expired links show an "expired" page. **+30 days** extends (e.g. after the customer pays).
   3 days after expiry the cron deletes the files from storage (`PURGE_GRACE_DAYS` in `wrangler.jsonc`).

## Deploy

```bash
pnpm wrangler login                          # once
pnpm wrangler secret put SUPABASE_URL
pnpm wrangler secret put SUPABASE_SERVICE_ROLE_KEY
pnpm wrangler secret put ADMIN_EMAILS        # optional
pnpm deploy
```

`VITE_*` values are baked in at build time from `.env`. Worker secrets live in Cloudflare, not in `.env`.

## Troubleshooting

- **"Failed to fetch dynamically imported module"** in dev: stop and restart `pnpm dev`. Deps used only by lazy admin
  routes must be listed in `optimizeDeps.include` in `vite.config.ts`; add new ones there. In production the app reloads
  itself once when this happens (e.g. right after a deploy).
- **Gallery or admin shows network errors**: the Supabase free project may have paused after a week idle. Resume it in the dashboard.

## Free-tier limits to keep in mind

Supabase free: **1 GB** file storage, **~5 GB/month** egress (every gallery view/download counts), and the project
**pauses after ~1 week idle**. At ~20 MB per session that's ~50 live sessions. Fine for a prototype; if it gets tight,
move photos to Cloudflare R2 (10 GB free, free egress). Only the storage helpers in `worker/index.ts` need to change.

## Not built yet (on purpose)

- Printing (frames already render at 300 DPI print size, so it's just a print step after "Save framed photo")
- Auto-import from the camera folder (File System Access API watching the tether folder)
- Payment for extensions (manual +30 days button for now)
- Per-slot pan/zoom in the frame editor (photos are centre-cropped to fill the slot)
