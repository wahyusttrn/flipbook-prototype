# Flipbook: self-photo studio prototype

Staff create a session, upload the camera photos and/or a **video take**, which is turned into **flipbook pages** in
the browser (the video is never uploaded), pick a **page design + cover**, and print the flipbook from a ready-made
**PDF**. They can also put photos into a frame. The customer scans a QR code to watch their flipbook, **save it as a
video or GIF**, and download the photos. Links expire after 10 days.

```
Vite + React (admin + public gallery)  ──►  /api/*  (Vercel Function → server/app.ts)
                │                                    │
                └──► Supabase: auth + DB ◄───────────┤
                                Storage (photos) ◄───┘
```

- **React app** (`src/`): admin at `/admin`, customer gallery at `/s/:slug`.
- **API** (`server/app.ts`, served by `api/index.ts` on Vercel): the only thing that touches the private storage bucket.
  Serves photos only while a session is valid, handles uploads, and a daily Vercel Cron deletes expired sessions' files.
- **Supabase**: admin login, tables and photo storage (private bucket `photos`), all from `supabase/schema.sql`.
- Image resizing, video frame extraction, compositing, MP4/GIF encoding and PDF layout all happen **in the browser**, so no
  server media processing is needed.

> Working on this with an AI agent? See [`AGENTS.md`](AGENTS.md) for the full architecture and conventions.

## Requirements

- Node 22+ and **pnpm** (this repo uses pnpm only; don't use npm/npx)
- A Supabase project (free tier). A Vercel account to deploy (local dev needs no Vercel CLI).

## Setup

1. **Install**: `pnpm install`
2. **Supabase**
   - SQL Editor → run `supabase/schema.sql` (creates tables, access rules **and** the storage bucket; safe to re-run).
     **Re-run it whenever it changes** (e.g. after pulling the flipbook update, which added the `takes` table).
   - Authentication → Sign In / Providers → **turn off "Allow new users to sign up"**.
     Any logged-in user is treated as staff, so this matters.
   - Authentication → Users → **Add user** (email + password) for each staff member.
3. **Env**: fill in `.env` (copy of `.env.example`). One file serves both the browser build and the API in dev.
   Use the new `sb_publishable_…` / `sb_secret_…` keys, not the legacy anon/service_role JWTs (retired in 2027):

   | Key | Where to find it | Used by |
   | --- | --- | --- |
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` (ref is in the dashboard URL, or click **Connect**) | browser |
   | `VITE_SUPABASE_ANON_KEY` | Settings → **API Keys** → Publishable key (`sb_publishable_…`) | browser |
   | `SUPABASE_URL` | same URL again | API |
   | `SUPABASE_SERVICE_ROLE_KEY` | Settings → **API Keys** → Secret keys (`sb_secret_…`, click the eye to reveal) | API only, never exposed |
   | `ADMIN_EMAILS` | optional, comma-separated staff allowlist | API |
   | `CRON_SECRET` | any random 16+ letters/digits; only needed on Vercel | API (daily cleanup) |
   | `PURGE_GRACE_DAYS` | optional, days after expiry before files are deleted (default 3) | API |

4. `pnpm dev` → open the printed URL + `/admin`. `/api/*` runs inside the Vite dev server.
   `GET /api/health` reports whether the API's env is complete.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server, including `/api/*` |
| `pnpm build` | Typecheck everything, then build the SPA into `dist/` |
| `pnpm typecheck` | `tsc -b` over app, API and Vite config |
| `pnpm lint` | oxlint |
| `pnpm preview` | Serve the production build locally (static only, no `/api`) |

## Using it

1. **Frames**: add a frame PNG/SVG at print size with **transparent photo holes**
   (e.g. 1200×1800 for 4R, 600×1800 for a 2×6 strip). Holes are detected automatically; fine-tune numbers if needed.
   Three ready-made frames are included as one-click samples (`public/sample-frames/`): **Classic strip** (2×6, 4 photos),
   **Film 35mm** (4R, 3 photos) and **Pastel party** (4R, 6 photos).
   **Flipbook page designs** live on the same page (type "Flipbook page design"): 3:2, e.g. 1800×1200 (3×2 in at
   600 DPI), exactly **one** transparent 16:9 hole, left 0.5 in kept free for the staples. Samples: **Flipbook classic**,
   **pastel**, **film** (dark film strip), **retro** (70s stripes) and **comic** (halftone + burst). Designs are applied on top of the pages; the stored pages never change.
2. **Sessions → Create** → drop **photos** (JPEG/PNG) and/or a **video** (MP4/MOV) into the upload area.
   - **Video → flipbook**: the app reads the video's frame rate and takes every Nth frame to get close to the chosen
     pages per second (default **12**: 24 fps → every 2nd frame, 60 fps → every 5th, 30 fps → every 3rd = 10/s). A 6 s take
     at 12/s = **72 pages**. Trim start/end if needed. Choose **upload all automatically** or **review and pick pages**
     (remembered per computer). Max 240 pages per take. Videos are read with the browser's video decoder (WebCodecs), so
     iPhone clips (HEVC, HDR, portrait) work too, also when uploading from Safari on the phone. If a browser can't decode a
     file, record in **H.264 (8-bit)** (iPhone: Settings → Camera → Formats → **Most Compatible**).
     The importer also asks for a **page design** and whether to add a **cover** (session name + date); right after
     upload the studio PC renders the customer **video (MP4)** and stores it with the take.
   - **Flipbook take card**: change the design / cover text → **Save design & remake video**. **Download video**,
     **Download GIF** (720 px wide, made on the spot, ~5–10 s).
     **Print PDF** (A4: 10 pages per sheet, Letter: 8, **4R: 4**) → print at **100% / Actual size**, cut on the grey lines,
     stack with the cover on top, staple on the left (page numbers sit in the binding margin). 4R (6×4 in photo paper) is
     edge to edge with no margins, so print it **borderless** and cut through the middle both ways.
   - **Frames**: pick a frame, tap a slot, tap a photo → **Save framed photo**.
   - Everything above also works **on a phone** (e.g. uploading a take straight from an iPhone in Safari).
3. Show the QR ("Show QR to customer") or copy the link. The customer sees their **flipbook video playing** with
   **Save video** (share sheet → Photos on phones, a download on computers) and **Save GIF** (built on their phone from the
   page thumbnails in a few seconds, 600 px, ~2–5 MB, same design and cover), the framed results and all shots, with
   "Save all to phone" (share sheet) or a .zip on desktop.
4. Expired links show an "expired" page. **+30 days** extends (e.g. after the customer pays).
   `PURGE_GRACE_DAYS` (default 3) after expiry, the daily cron deletes the files from storage.

## Deploy (Vercel)

Everything is configured in `vercel.json` (build output `dist/`, `/api/*` → `api/index.ts`, SPA fallback, daily cron).

1. Import the GitHub repo in Vercel. Leave the build settings as they are; `vercel.json` overrides them.
2. Project → Settings → **Environment Variables**: add every key from the table above (Production, and Preview if you use it).
   `VITE_*` values are baked in at build time, so **redeploy after changing them**.
3. Push to `main` → Vercel builds and deploys. Check `https://<your-app>.vercel.app/api/health` → `{"ok":true}`.
4. Optional: Settings → Functions → **Function Region**: pick the one closest to your Supabase region
   (Supabase → Settings → General). Each API call talks to Supabase several times, so this makes it noticeably faster.

The cron (`/api/cron/purge`, daily ~03:00 UTC) only runs on the production deployment. On the Hobby plan it can fire
anytime within that hour.

## Troubleshooting

- **"Failed to fetch dynamically imported module"** in dev: stop and restart `pnpm dev`. Deps used only by lazy admin
  routes must be listed in `optimizeDeps.include` in `vite.config.ts`; add new ones there. In production the app reloads
  itself once when this happens (e.g. right after a deploy).
- **Gallery or admin shows network errors**: the Supabase free project may have paused after a week idle. Resume it in the dashboard.
- **"This browser can't read this video"**: the browser has no decoder for that codec (e.g. HEVC on some Windows PCs).
  Record in H.264, or use Chrome/Edge/Safari on a Mac.
- **"This browser can't make MP4 videos"**: use Chrome or Edge on the studio PC (needs the WebCodecs video encoder).
- **Upload fails with 413**: Vercel functions accept at most 4.5 MB per request. Browser-resized photos are ~0.5–2 MB, so
  this only happens with unusual files.
- **Vercel shows NOT_FOUND on every page**: the deployment isn't using `vercel.json` (check it's committed), or
  the Output Directory was overridden to something other than `dist`.

## Free-tier limits to keep in mind

Supabase free: **1 GB** file storage, **~5 GB/month** egress (every gallery view/download counts), and the project
**pauses after ~1 week idle**. At ~20 MB per session (a 72-page take is ~15–25 MB, its video 0.3–3 MB) that's ~40–50 live sessions. Fine for a prototype; if it gets tight,
move photos to Cloudflare R2 (10 GB free, free egress). Only the storage helpers in `server/app.ts` need to change.

## Not built yet (on purpose)

- Printing framed photos (frames already render at 300 DPI print size, so it's just a print step after "Save framed photo")
- Auto-import from the camera folder (File System Access API watching the tether folder)
- Payment for extensions (manual +30 days button for now)
- Per-slot pan/zoom in the frame editor (photos are centre-cropped to fill the slot)
