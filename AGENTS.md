# AGENTS.md

Everything an AI agent needs to work on this repo. `README.md` is the short developer
guide; this file is the detailed one. **Keep both up to date** (see [Docs rule](#docs-rule)).

---

## 1. Product context

**Flipbook** is a prototype (MVP) for a **walk-in self-photo studio that also prints**.

Real-world flow at the studio:
1. Customer shoots in the booth with a **mirrorless camera** (remote shutter).
2. Staff create a **session** and **upload the photos manually** (auto-import is deferred).
3. Staff (or customer at the station) pick a **frame template** and place photos into its slots.
4. Customer gets a **QR code / public link** → gallery with the framed result + all raw shots.
5. Link is valid **10 days**. Staff can extend (**+30 days**), intended for after a payment.
6. Files are deleted from storage **3 days after expiry** by a cron.

Deliberately **out of scope for now** (user decisions, 2026-11-07). Don't build them unless asked:
- **Printing**: print size and printer model are undecided. Frames already render at full template
  resolution (designed at 300 DPI), so printing will be a step after compositing.
- **Camera-folder auto-import**: later via the File System Access API (`showDirectoryPicker`) polling the tether folder.
- **Payment gateway** for extensions: manual "+30 days" button instead (Midtrans/Xendit later, QRIS context: Indonesia).
- **Full customer-side photo editor** (filters, stickers, crop). Rejected as too big for an MVP.
- **Per-slot pan/zoom**: photos are centre-cropped (`object-fit: cover`) into slots.

Constraint: everything must run on **free tiers**: Supabase free (DB, auth, **storage**) + Cloudflare Workers free.
Storage decision (2026-11-08): the user chose **Supabase Storage over Cloudflare R2** to avoid extra setup for the
prototype, accepting the 1 GB / ~5 GB egress limits. R2 is the planned upgrade path if limits bite (see §11).

---

## 2. Stack

| Layer | Tech | Notes |
| --- | --- | --- |
| Frontend | Vite 8, React 19 + **React Compiler**, TypeScript 7 (`tsc -b`), Tailwind v4, react-router v8 | SPA |
| API | **Cloudflare Worker** via `@cloudflare/vite-plugin` | Same repo, same dev server, same deploy |
| Storage | **Supabase Storage**, private bucket `photos` | Accessed only by the Worker with the service-role key |
| DB + auth | **Supabase** (Postgres + email/password auth) | `supabase/schema.sql` |
| Lint | oxlint | `.oxlintrc.json` |
| Package manager | **pnpm only** | Never use npm / npx / yarn. Use `pnpm <script>`, `pnpm exec`, `pnpm wrangler …` |

Other deps: `@supabase/supabase-js`, `qrcode` (QR images), `fflate` (zip in browser).

---

## 3. Architecture

```
Browser (React SPA)
 ├─ /admin/*  ── supabase-js (RLS, logged-in staff) ──► Supabase: sessions, templates (read/write), photos (read)
 │           └─ fetch /api/admin/* (Bearer <supabase access token>) ──► Worker
 └─ /s/:slug  ── fetch /api/public/* (no auth) ──► Worker
Worker (/api/*, run_worker_first)
 ├─ Supabase service-role client (bypasses RLS)
 └─ Supabase Storage (private bucket "photos") via the same service-role client
Cron (daily 03:00 UTC) ──► Worker.scheduled → purgeExpired()
```

Key design decisions (and why):
- **Worker in front of storage**: the bucket is private with **no storage policies**; only the Worker (service role)
  reads/writes it, so photos are only served while the session is not expired (checked server-side). Proxying also keeps
  image URLs same-origin, which canvas compositing needs. Don't switch to public buckets or signed URLs without
  handling expiry and canvas CORS (`crossOrigin`).
- **Uploads go through the Worker** (multipart POST), not signed upload URLs, so the DB row and the files are written
  together and files are small after browser resizing. Worker request body limit (100 MB on free) is far above `MAX_UPLOAD_BYTES` (25 MB).
- **All image processing is in the browser** (canvas): resize before upload, frame compositing, hole detection.
  No server image processing, which keeps it free and simple.
- **Photo rows are written only by the Worker** (service role), together with the file upload, so DB and storage stay consistent.
  Sessions and templates' simple fields are written by the admin client directly through RLS.
- **Public gallery never talks to Supabase directly**; it goes through the Worker, which enforces expiry.
- **Lazy-only deps must be pre-bundled**: anything imported only from lazy admin routes goes in `optimizeDeps.include`
  (`vite.config.ts`). Otherwise Vite discovers it on first visit, re-optimizes, and the chunk import fails
  ("Failed to fetch dynamically imported module"). Currently: `@supabase/supabase-js`, `qrcode`, `fflate`.
- **Gallery bundle is kept small**: admin routes are lazy-loaded and `src/lib/publicApi.ts` has no Supabase import.
  Don't import `supabase.ts` / `api.ts` from `pages/Gallery.tsx` or anything it imports.

---

## 4. Repo map

```
worker/index.ts            Worker: router table, handlers, auth check, storage helpers, cron purge
wrangler.jsonc             Worker config: assets SPA fallback, vars, cron, compat date (no bindings)
worker-configuration.d.ts  Generated by `pnpm cf-types` (committed). Regenerate after wrangler/env changes
supabase/schema.sql        Tables, indexes, RLS, storage bucket. Idempotent; run in Supabase SQL editor
.env / .env.example        All env for both Vite (VITE_*) and the Worker (wrangler reads .env too)

src/main.tsx               Entry: RouterProvider
src/App.tsx                Route table: root route has errorElement + hydrateFallbackElement; admin routes lazy-loaded
src/admin.tsx              AdminRoot = RequireAuth + AdminLayout (lazy chunk boundary)
src/index.css              Tailwind import, theme fonts (Inter, Fraunces), .checker background

src/lib/shared.ts          Types + constants shared by app AND Worker (Session, Photo, Template, Slot,
                           PublicSession, SESSION_DAYS, RAW_MAX_EDGE, THUMB_MAX_EDGE, MAX_UPLOAD_BYTES, STORAGE_BUCKET, storageKeys, isExpired)
src/lib/supabase.ts        Browser supabase client + isSupabaseConfigured (placeholder-aware)
src/lib/publicApi.ts       ApiError + public endpoints (NO supabase import)
src/lib/api.ts             Authed request() + adminApi (uploads, deletes, photoBlob cache); re-exports publicApi
src/lib/image.ts           decode, loadImage, resizeToJpeg, prepareUpload, drawCover, composeFrame, detectSlots, toBlob
src/lib/download.ts        downloadBlob(blob, filename)
src/lib/format.ts          DAY_MS, formatDate, formatDateTime, daysLeft, publicLink
src/lib/slug.ts            randomSlug(): 10 chars, no look-alike characters

src/components/ui.tsx      Button (primary|secondary|ghost|danger), Spinner, Card, ErrorText, Badge
src/components/useAuth.ts  Supabase session hook (undefined = loading, null = logged out)
src/components/RequireAuth.tsx, SetupNotice.tsx, AdminLayout.tsx
src/components/AdminImage.tsx   <img> for admin-only photos (fetched as blob with auth header)
src/components/Uploader.tsx     Drag/drop + picker, resize, upload with concurrency 2
src/components/Composer.tsx     Frame picker, slot assignment, live preview, full-res render + upload
src/components/RouteError.tsx  App error page; auto-reloads once (sessionStorage flag) when a lazy chunk fails to load
src/components/QrCode.tsx, SessionStatus.tsx

src/pages/Login.tsx, Sessions.tsx (list + create), SessionDetail.tsx (link/QR, upload, compose, results),
          Templates.tsx (frames list + new frame with auto slot detection), Gallery.tsx (public), NotFound.tsx

public/sample-frames/      Sample frames (SVG, transparent holes), listed in SAMPLES in Templates.tsx:
                           classic-strip.svg 600×1800 (4 slots), film-35mm.svg 1200×1800 (3), pastel-party.svg 1200×1800 (6).
                           All three were also installed into the Supabase project on 2026-11-08.
                           SVG rules: width/height attrs, holes cut with a <mask>, decorations that look like holes
                           (e.g. film sprockets) must be opaque, system fonts only (web fonts don't load in <img> SVGs)
```

---

## 5. Data model (Supabase)

```
sessions  id uuid PK, slug text UNIQUE, name text, created_at, expires_at (default now()+10d), purged_at nullable
templates id uuid PK, name, width int, height int, overlay_key text, slots jsonb [{x,y,w,h}], created_at
photos    id uuid PK, session_id → sessions ON DELETE CASCADE, kind 'raw'|'framed', storage_key, thumb_key,
          width, height, template_id → templates ON DELETE SET NULL, created_at
```

Session state is derived, not stored: **expired** = `purged_at IS NOT NULL OR expires_at <= now()` (`isExpired()`).
`purged_at` set = files are gone; UI disables extend/upload.

**RLS**: `authenticated` has full access to `sessions` and `templates`, **select only** on `photos`.
`anon` has nothing. The Worker uses the service role. Because "authenticated == staff", **public sign-ups must be
disabled** in Supabase; `ADMIN_EMAILS` is an extra allowlist enforced by the Worker only (not by RLS).

Schema changes: edit `supabase/schema.sql` keeping it **idempotent** (`if not exists`, `drop policy if exists`),
update types in `src/lib/shared.ts`, and note in both docs that the SQL must be re-run.

### Storage layout (bucket `photos`, `storageKeys` in shared.ts)
```
sessions/{sessionId}/{raw|framed}/{photoId}.jpg
sessions/{sessionId}/{raw|framed}/{photoId}_thumb.jpg
templates/{templateId}.png
```
Deleting a session = list + remove the `sessions/{id}/raw` and `sessions/{id}/framed` folders (`deleteSessionFiles`;
Supabase `list()` is one level deep, so new kinds need adding there). Bucket limits: 25 MB per file, JPEG/PNG only.
An older schema had `photos.r2_key`; `schema.sql` renames it to `storage_key` if present.

---

## 6. Worker API (`worker/index.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | `{ok, error?}`; 503 if env missing |
| GET | `/api/public/sessions/:slug` | none | `PublicSession`: `{status:'ok', name, expires_at, photos[]}` or `{status:'expired', …}`; 404 unknown |
| GET | `/api/public/photos/:id/:variant(full\|thumb)[?download=1]` | none | Streams from storage; **410 if expired** |
| GET | `/api/templates/:id/overlay` | none | Frame PNG (needed same-origin for canvas) |
| GET | `/api/admin/photos/:id/:variant` | staff | Same as public but ignores expiry |
| POST | `/api/admin/sessions/:id/photos` | staff | multipart `full`, `thumb` (image/jpeg), `kind`, `width`, `height`, `template_id?` → photo row |
| DELETE | `/api/admin/photos/:id` | staff | Files + row |
| DELETE | `/api/admin/sessions/:id` | staff | Session folders + row (photos cascade) |
| POST | `/api/admin/templates` | staff | multipart `overlay` (image/png), `name`, `width`, `height`, `slots` (JSON, 1–20) |
| DELETE | `/api/admin/templates/:id` | staff | Overlay file + row (framed photos keep, `template_id` → null) |
| POST | `/api/admin/purge` | staff | Run cleanup now → `{purged}` |

Conventions:
- Routes are a table of `[method, regex, admin, handler]`. Add new routes there; IDs match `([0-9a-f-]{36})`.
- Throw `new HttpError(status, message)` for expected errors; anything else → 500 with the message. Responses are JSON `{error}`.
- "staff" = valid Supabase access token in `Authorization: Bearer …` (checked with `auth.getUser`) and, if
  `ADMIN_EMAILS` is set, email in that list.
- Every `/api` route except `/api/health` returns 503 with a clear message if Supabase env is missing/placeholder.
- When writing files + DB together, remove the uploaded files if anything fails (see `uploadPhoto`, `createTemplate`).
- Storage helpers: `putObject`, `removeObjects` (batches of 100), `serveObject`, `deleteSessionFiles`. All storage access goes
  through these, so switching to R2 later only means changing them (plus an `r2_buckets` binding in `wrangler.jsonc`).
- Cron: `purgeExpired()` handles ≤50 sessions per run whose `expires_at < now - PURGE_GRACE_DAYS`, deletes the session's files and
  photo rows, sets `purged_at`. The session row is kept so the gallery can still say "expired".
- Images are served with `cache-control: private, max-age=3600`. After expiry a cached copy can live up to 1 h on the device. Acceptable.

---

## 7. Frontend flows

### Upload (`Uploader.tsx` → `prepareUpload` → `adminApi.uploadPhoto`)
Camera JPEG → `createImageBitmap(file, {imageOrientation:'from-image'})` (respects EXIF rotation) →
full JPEG at **long edge 2400px, q0.88** + thumb **480px, q0.8** → multipart POST. Concurrency 2, per-file errors listed.

### Frames / templates (`Templates.tsx`)
Upload PNG/SVG/WebP → rasterised to PNG at natural size → `detectSlots()` finds connected **transparent**
regions (alpha < 32) on a ≤600px downscale, drops regions < 0.5% of area, pads boxes by one sample, sorts in
reading order → admin can edit x/y/w/h or remove slots → `adminApi.createTemplate`.
SVG frames **must have `width`/`height` attributes**. Frames should be designed at print size (300 DPI).

### Compose (`Composer.tsx`)
`slots` = one photo id (or null) per template slot. Click a slot to select it, click a photo to assign it (it then jumps to the next empty slot).
Preview: `composeFrame()` from **thumbnails** at `PREVIEW_HEIGHT` scale (fast). Save: re-composes from **full**
images at template resolution, JPEG q0.92 + thumb, uploads as `kind:'framed'` with `template_id`.
Draw order: white background → photos (cover-cropped into slots, empty slots grey) → overlay on top.

### Admin images
`<img>` can't send auth headers, so admin photos are fetched via `adminApi.photoBlob()` (promise cache per page load)
and shown as object URLs (`AdminImage`). Full-size blobs are only fetched when needed (compose / Save button).
Never pre-load full images for grids.

### Public gallery (`Gallery.tsx`)
States: loading / 404 "Link not found" / error / expired / empty ("photos are on their way") / ok.
Framed first (served **full size**: few and the hero, thumbs look soft on phones), then raw grid (thumbs); lightbox with keyboard + tap zones + download (`?download=1`).
"Save all": on devices that can share files → fetch all, then a **second tap** opens `navigator.share({files})`
(share needs a fresh user gesture); otherwise zip with `fflate.zipSync(level 0)` and download.

### Sessions
Create inserts `{slug: randomSlug(), name, expires_at: now + SESSION_DAYS}` directly via supabase-js.
Extend: `max(now, expires_at) + 30 days`. Rename via `window.prompt`. Delete via Worker.

---

## 8. Conventions

- **pnpm only.** Scripts: `pnpm dev | build | typecheck | lint | cf-types | preview | deploy`. Wrangler: `pnpm wrangler …`.
  Adding deps: `pnpm add` / `pnpm add -D`. If a new dep needs a build script, approve it with
  `pnpm approve-builds <pkg> -y` (writes `allowBuilds` in `pnpm-workspace.yaml`).
- **React Compiler is on**: don't add `useMemo`/`useCallback`/`memo` for performance. Plain `useState` + `useEffect`
  data loading; no global state library. Keep effects cancel-safe (`let alive = true` pattern).
- **Styling**: Tailwind utility classes, stone palette, `font-display` (Fraunces) for headings. Reuse `ui.tsx` primitives
  before writing new button/card styles. Admin is desktop-first; the gallery is **mobile-first**.
- **Types shared with the Worker go in `src/lib/shared.ts`** (it's included in `tsconfig.worker.json`). It must stay
  free of DOM/browser APIs.
- `tsconfig` is split: `tsconfig.app.json` (src), `tsconfig.worker.json` (worker + shared.ts), `tsconfig.node.json` (vite config).
- Component files should only export components (oxlint `only-export-components`); put hooks/helpers in their own files.
- Destructive admin actions use `window.confirm` (prototype-level UX is fine).
- Code comments explain *why*, briefly. No dead code; no placeholder TODO files.

---

## 9. Env & config

`.env` (gitignored) is read by **Vite** (only `VITE_*` reach the browser) **and by Wrangler** (Worker env in dev,
because there's no `.dev.vars`). Don't create `.dev.vars`; it would make Wrangler ignore `.env`.

| Key | Side | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | browser | URL `https://ggdwsnufmpcrcmdcpegz.supabase.co`. Key = **publishable** key `sb_publishable_…` (Settings → API Keys). Placeholders (`YOUR-PROJECT`, `your-…`) are treated as "not configured" → `SetupNotice` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Worker | Key = **secret** key `sb_secret_…` (Settings → API Keys). **Never** prefix with `VITE_`. In production: `pnpm wrangler secret put …` |
| `ADMIN_EMAILS` | Worker | Optional comma-separated allowlist |

`wrangler.jsonc`: `compatibility_date` must not be newer than the installed `workerd` supports.
`vars.PURGE_GRACE_DAYS` = 3. Cron `0 3 * * *`. No bindings (storage is Supabase). After any change to bindings/vars/env
keys run `pnpm cf-types`. The SPA fallback (`not_found_handling: single-page-application`) + `run_worker_first: ["/api/*"]`
is what makes `/admin/...` and `/s/:slug` deep links work.

Use the new Supabase key format (`sb_publishable_…` / `sb_secret_…`); legacy anon/service_role JWT keys are retired in early 2027.
The env var *names* still say `ANON_KEY` / `SERVICE_ROLE_KEY`; they hold the new keys.

Changing the session length: `SESSION_DAYS` in `shared.ts` **and** the column default in `schema.sql`.

---

## 10. Verifying changes

Always run before saying a change is done:
```bash
pnpm typecheck && pnpm lint && pnpm build
```
Smoke test the Worker without Supabase keys: `pnpm dev`, then `curl localhost:<port>/api/health` (expects 503 with a
"Missing env" message) and `curl localhost:<port>/api/nope` (404 JSON). `/s/anything` must return the SPA HTML.

Browser-only code (`src/lib/image.ts`) can't run in Node (no canvas). To test it, serve a temporary HTML page from
`public/` that imports `/src/lib/image.ts`, open it in headless Chrome via the DevTools protocol (`--dump-dom` dumps
before async module code finishes, so poll with `Runtime.evaluate`), then **delete the temp page**. Expected results on the
samples: classic-strip → 4 slots ≈ `{33,33,534,378}`…; film-35mm → 3 ≈ `{147,57,906,492}`…;
pastel-party → 6 ≈ `{57,237,531,456}`… (detected boxes are ~3px larger than the holes on purpose).

End-to-end against the real project (done 2026-11-08, all 46 checks passed). Method, if you repeat it:
- Use a **temporary staff user** created with the service key (`auth.admin.createUser`, `email_confirm: true`) and sign in
  with the publishable key. Never ask for or use the owner's password. **Delete the user and all test rows/files after.**
- Test scripts and fixtures live in the scratchpad, not the repo. Run Node scripts that need `@supabase/supabase-js` from the
  repo root (copy in as a dotfile, run with `node --env-file=.env`, then delete). Real JPEGs: generate PNGs, convert with `sips`.
- API phase: every route, 401/415/404/410 paths, RLS (anon can't read tables, staff can't insert photos, bucket is private),
  expiry → extend → purge → deletes. Browser phase (Chrome via DevTools protocol): log in through the form (React inputs
  need the native value setter + `input` event), Auto-fill + Save framed photo, check composited pixel colours, and the
  gallery at 390px width (images load, no horizontal scroll, lightbox, unknown slug).
- Run your own dev server on a separate port (`pnpm dev --port 5199 --strictPort`) as a tracked background task and stop
  it by task/PID. **Never `pkill` vite/workerd or delete `node_modules/.vite`**: the user may have their own dev server running.

---

## 11. Gotchas

- **Supabase free projects pause after ~1 week of inactivity.** A paused project looks like network errors.
- **Supabase Storage free**: **1 GB** files, **~5 GB/month egress** shared with DB traffic. Every gallery thumbnail and
  download is proxied by the Worker but still counts as Supabase egress. ~20 MB per session → ~50 live sessions.
  Browser resizing keeps photos ~0.5–1 MB; never store camera originals. Upgrade path: Cloudflare R2 (10 GB, free egress).
- `createImageBitmap` on 40+ MP JPEGs uses a lot of memory. Upload concurrency is capped at 2 and bitmaps are `.close()`d.
- Canvas reads (compose, detect) need **same-origin** images. That's why overlays are served through `/api/templates/:id/overlay`.
  Don't switch to public bucket URLs without adding CORS handling + `crossOrigin`.
- `navigator.share` must be called directly from a tap. Hence the two-step "Save all" on phones.
- HEIC isn't decodable in Chrome; the camera shoots JPEG, so uploads accept JPEG/PNG/WebP only.
- New lazy-route dependency? Add it to `optimizeDeps.include` (see §3).
- TypeScript is v7 (`tsc` native). Use `tsc -b` via `pnpm typecheck`.

---

## 12. Roadmap hints (when the user asks)

- **Printing**: after compositing, print the framed canvas: a print-only page sized to the paper with `@page { size: 4in 6in; margin: 0 }`,
  run the station Chrome with `--kiosk-printing` to skip the dialog. Add the QR code onto the print (the slug exists before compositing).
  Printing must not wait for uploads: compose locally → print → upload in background.
- **Auto-import**: File System Access API on the station PC, poll the tether folder, feed new files into `Uploader`'s pipeline.
- **Customer frame switching** on the gallery: reuse `composeFrame` + public overlay endpoint with the session's raw photos.
- **Payments**: Midtrans/Xendit (QRIS) webhook → Worker → extend `expires_at`.

---

## Docs rule

`README.md` (developer quick start) and `AGENTS.md` (this file) are the two docs to maintain. When you change
behaviour, routes, schema, env keys, scripts, constants or scope, update **both** in the same change. README stays short and
practical; AGENTS.md gets the details and the reasons behind them.

`CLAUDE.md` only contains `@AGENTS.md` (so Claude Code loads this file automatically). Don't add content to it;
put everything here instead.
