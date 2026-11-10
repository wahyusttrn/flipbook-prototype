# AGENTS.md

Everything an AI agent needs to work on this repo. `README.md` is the short developer
guide; this file is the detailed one. **Keep both up to date** (see [Docs rule](#docs-rule)).

---

## 1. Product context

**Flipbook** is a prototype (MVP) for a **walk-in self-photo studio that also prints**. The client's main product is a
**printed video flipbook**: a short video take becomes ~60–80 pages that are printed, cut and bound, so flipping them plays the clip.

Real-world flow at the studio:
1. Customer shoots in the booth with a **mirrorless camera**: photos and/or **~6 s video takes**.
2. Staff create a **session** and **upload photos manually** and/or drop a **video**, which the browser turns into flipbook
   pages (only the chosen frames are uploaded; the video never leaves the studio PC). Auto-import is deferred.
3. Staff (or customer at the station) pick a **frame template** and place photos into its slots.
4. Customer gets a **QR code / public link** → gallery with the framed result + all raw shots.
5. Link is valid **10 days**. Staff can extend (**+30 days**), intended for after a payment.
6. Files are deleted from storage **3 days after expiry** by a cron.

Deliberately **out of scope for now** (user decisions, 2026-11-07). Don't build them unless asked:
- **Printing** (flipbook and framed photos): print size and printer model are undecided. Frames already render at full template
  resolution (designed at 300 DPI), so printing will be a step after compositing.
- **Camera-folder auto-import**: later via the File System Access API (`showDirectoryPicker`) polling the tether folder.
- **Payment gateway** for extensions: manual "+30 days" button instead (Midtrans/Xendit later, QRIS context: Indonesia).
- **Full customer-side photo editor** (filters, stickers, crop). Rejected as too big for an MVP.
- **Per-slot pan/zoom**: photos are centre-cropped (`object-fit: cover`) into slots.

Constraint: everything must run on **free tiers**: Supabase free (DB, auth, **storage**) + Vercel Hobby (hosting + API + cron).
Hosting decision (2026-11-08): the user deploys on **Vercel**. The API was first a Cloudflare Worker and was ported to a
Vercel Function; Cloudflare is no longer used anywhere.
Storage decision (2026-11-08): the user chose **Supabase Storage over Cloudflare R2** to avoid extra setup for the
prototype, accepting the 1 GB / ~5 GB egress limits. R2 is the planned upgrade path if limits bite (see §11).

Flipbook output decisions (2026-11-10): **customers get an MP4** (best for phones/sharing; GIF is 5–10× bigger and
banded), rendered **once on the studio PC** and stored with the take (works on any phone, small egress); **the studio gets
a print-ready PDF**; zip downloads were removed. **GIF export added on request (2026-11-10)**: staff "Download GIF" and customer
"Save GIF", both generated in the browser on demand and **never stored** (GIF is 2–10 MB and 256-colour, so the MP4 stays the
main "Save video" output; GIF is for places that need an auto-looping image). Page = **3×2 in landscape, 0.5 in binding margin on the left**. Designs
are **non-destructive** (overlay + optional cover drawn on top; stored pages never change).
Flipbook decisions (2026-11-10): default **12 pages per second** (user's client asked for ~11; 12 lands exactly on 24/60 fps
frames). Staff choose per import between **auto** (upload all) and **pick** (review grid). PNG photos are accepted and
stored as JPEG like everything else (user: keep that).

---

## 2. Stack

| Layer | Tech | Notes |
| --- | --- | --- |
| Frontend | Vite 8, React 19 + **React Compiler**, TypeScript 7 (`tsc -b`), Tailwind v4, react-router v8 | SPA |
| API | **Vercel Function** `api/index.ts` → host-agnostic `server/app.ts` (Web `Request`→`Response`) | In dev, a Vite middleware runs the same handler |
| Storage | **Supabase Storage**, private bucket `photos` (JPEG, PNG, MP4) | Accessed only by the API with the service-role key |
| Media | **mediabunny** (MP4 via WebCodecs `VideoEncoder`), **pdf-lib** (print PDF), **gifenc** (GIF, no types: `src/lib/gifenc.d.ts`) | Lazy-loaded chunks; gifenc also loads in the gallery |
| DB + auth | **Supabase** (Postgres + email/password auth) | `supabase/schema.sql` |
| Lint | oxlint | `.oxlintrc.json` |
| Hosting | **Vercel** (`vercel.json`) | SPA from `dist/`, `/api/*` rewrite to the function, daily cron |
| Package manager | **pnpm only** | Never use npm / npx / yarn. Use `pnpm <script>`, `pnpm exec`, `pnpm dlx` |

Other deps: `@supabase/supabase-js`, `qrcode` (QR images), `fflate` (zip in browser).

---

## 3. Architecture

```
Browser (React SPA, static from dist/)
 ├─ /admin/*  ── supabase-js (RLS, logged-in staff) ──► Supabase: sessions, templates (read/write), photos (read)
 │           └─ fetch /api/admin/* (Bearer <supabase access token>) ──► API
 └─ /s/:slug  ── fetch /api/public/* (no auth) ──► API
API = handleApi() in server/app.ts
 ├─ prod: vercel.json rewrites /api/:path* → /api?__path=:path* → api/index.ts restores the path → handleApi
 ├─ dev:  server/devApi.ts (Vite middleware) → ssrLoadModule('/server/app.ts') → handleApi, env from .env
 ├─ Supabase service-role client (bypasses RLS)
 └─ Supabase Storage (private bucket "photos") via the same service-role client
Vercel Cron (daily ~03:00 UTC, prod only) ──► GET /api/cron/purge (Bearer CRON_SECRET) → purgeExpired()
```

Key design decisions (and why):
- **API in front of storage**: the bucket is private with **no storage policies**; only the API (service role)
  reads/writes it, so photos are only served while the session is not expired (checked server-side). Proxying also keeps
  image URLs same-origin, which canvas compositing needs. Don't switch to public buckets or signed URLs without
  handling expiry and canvas CORS (`crossOrigin`).
- **Uploads go through the API** (multipart POST), not signed upload URLs, so the DB row and the files are written
  together. **Vercel caps request and response bodies at 4.5 MB**, so `MAX_UPLOAD_BYTES` is 4 MB per file and full + thumb
  must fit in one request. Browser resizing (2400px, q0.88) keeps photos ~0.5–2 MB. If you raise `RAW_MAX_EDGE` or quality,
  check this limit, or switch to signed upload URLs straight to Supabase.
- **One function for the whole API** (Vercel's recommendation for Fluid compute): don't add more files in `api/`; add routes to
  the table in `server/app.ts`. Files in `api/` become functions, so shared code lives in `server/`.
- **`server/app.ts` must stay host-agnostic**: Web `Request`/`Response` only, env passed in as `ServerEnv`. No `process.env`
  reads inside it (the Vercel entry and the dev middleware pass env in).
- **All image processing is in the browser** (canvas): resize before upload, frame compositing, hole detection.
  No server image processing, which keeps it free and simple.
- **Photo rows are written only by the API** (service role), together with the file upload, so DB and storage stay consistent.
  Sessions and templates' simple fields are written by the admin client directly through RLS.
- **Public gallery never talks to Supabase directly**; it goes through the API, which enforces expiry.
- **Lazy-only deps must be pre-bundled**: anything imported only from lazy admin routes goes in `optimizeDeps.include`
  (`vite.config.ts`). Otherwise Vite discovers it on first visit, re-optimizes, and the chunk import fails
  ("Failed to fetch dynamically imported module"). Currently: `@supabase/supabase-js`, `qrcode`, `fflate`, `mediabunny`,
  `pdf-lib`, `gifenc`.
- **Video never leaves the browser** (`src/lib/video.ts`). `openVideo(file, url)` returns a `VideoReader` from one of two engines:
  - **decoder** (preferred, 2026-11-10): mediabunny `Input(BlobSource)` + WebCodecs. Frame rate =
    `computeFrameRateMetrics().bestGuessFrameRate` (from frame timestamps), frames from `CanvasSink.canvasesAtTimestamps`
    (decoded at output size, file rotation applied, timestamps offset by `getFirstTimestamp()`). ~4× faster than seeking
    (72 pages ≈ 0.7 s). **Why it exists:** iPhone Safari ignores `preload` and loads no picture for a hidden `<video>`, so
    uploading from the phone timed out on `loadeddata`. Used when `VideoDecoder` exists and `track.canDecode()`.
  - **element** (fallback: no WebCodecs, or a codec the decoder can't handle): hidden `<video>`, waits for
    `loadedmetadata`, then a muted `play()` if no picture is loaded yet (the iOS rule), `detectFps()` measures the real rate
    from `requestVideoFrameCallback` timestamps (½ s of muted playback, smallest gap), one seek per frame.
  Both snap the rate to the *closest* standard rate (24 vs 23.976 is only 0.1%) and pick **identical frames** (verified, §10).
  `planFrames()` picks every Nth source frame whose rate is closest to the target and aims at the **middle** of each frame
  `(f + 0.5) / fps` so a lookup never lands on a neighbour; without a known fps it samples by time (`start + k/target + 1ms`). Frames are drawn to canvas → JPEG (≤1920px, q0.85)
  + 480px thumb, then uploaded as photos with `kind: 'frame'`. Verified with frame-numbered ffmpeg videos (§10).
- **Flipbook outputs are made on the studio PC**: `makeFlipbookVideo` (H.264 MP4, long edge ≤1280, QUALITY_MEDIUM, retried at
  LOW if over 4 MB; timeline = 1 s cover + one page per 1/fps + ½ s hold on the last page) is uploaded to the take and
  served to customers; `makeFlipbookPdf` is generated on demand for staff and never stored. Both import their libraries
  with `await import(...)` so the session page chunk stays ~65 KB.
- **GIFs are made where they're downloaded** (`makeFlipbookGif`, gifenc): staff from full pages at 720 px, customers on their
  phone from the 480 px thumbs at 600 px (480 without a design). Same timing as the MP4 (cover 1 s, ½ s end hold, delays
  rounded on a running clock in 1/100 s), one 256-colour palette per page picked from ¼ of the pixels (halves the time, same look).
- **Pages are downloaded ahead** (`prefetch()`, 6 at a time) for every video/PDF/GIF job. Fetching one by one (~0.4 s each
  through the API) made a 48-page GIF take 25–40 s; with read-ahead it's ~4–7 s.
- **Gallery bundle is kept small**: admin routes are lazy-loaded and `src/lib/publicApi.ts` has no Supabase import.
  Don't import `supabase.ts` / `api.ts` from `pages/Gallery.tsx` or anything it imports.

---

## 4. Repo map

```
server/app.ts              API: handleApi(req, env, url?), ServerEnv, router table, handlers, auth check,
                           storage helpers, purgeExpired (+ /api/cron/purge)
server/devApi.ts           Vite plugin: serves /api/* in `pnpm dev` with handleApi (Node req → Web Request)
api/index.ts               Vercel Function entry (`export default { fetch }`); restores the path from `__path`
vercel.json                framework vite, pnpm install/build, outputDirectory dist, rewrites, crons
supabase/schema.sql        Tables, indexes, RLS, storage bucket. Idempotent; run in Supabase SQL editor
.env / .env.example        All env: VITE_* for the browser build, the rest for the API (dev reads .env via loadEnv)

src/main.tsx               Entry: RouterProvider
src/App.tsx                Route table: root route has errorElement + hydrateFallbackElement; admin routes lazy-loaded
src/admin.tsx              AdminRoot = RequireAuth + AdminLayout (lazy chunk boundary)
src/index.css              Tailwind import, theme fonts (Inter, Fraunces), .checker background

src/lib/shared.ts          Types + constants shared by app AND API (Session, Photo, Template, Slot,
                           PublicSession, SESSION_DAYS, RAW_MAX_EDGE, THUMB_MAX_EDGE, MAX_UPLOAD_BYTES, STORAGE_BUCKET, storageKeys, isExpired)
src/lib/supabase.ts        Browser supabase client + isSupabaseConfigured (placeholder-aware)
src/lib/publicApi.ts       ApiError + public endpoints (NO supabase import)
src/lib/api.ts             Authed request() + adminApi (uploads, deletes, photoBlob cache); re-exports publicApi
src/lib/image.ts           decode, loadImage, resizeToJpeg, prepareUpload, drawCover, composeFrame, detectSlots, toBlob
src/lib/video.ts           openVideo → VideoReader (engine 'decoder' | 'element': width, height, duration, fps, extract,
                           dispose), planFrames, VideoReadError (browser-only)
src/lib/zip.ts             zipFiles([{name, blob}]) via fflate (level 0), used by the gallery's desktop "Download all"
src/lib/flipbook.ts        Page rendering shared by preview/MP4/PDF: loadDesign (cached overlay), renderPage, renderCover
                           (title/subtitle over a gradient in the photo hole), renderPrintPage (900×600 = 3×2 in @300 DPI;
                           without a design: built-in white page, binding margin + staple guide), defaultCover
src/lib/flipbookVideo.ts   makeFlipbookVideo → MP4 Blob (mediabunny CanvasSource, codec avc)
src/lib/flipbookGif.ts     makeFlipbookGif → GIF Blob (gifenc; used by TakeCard AND the gallery, so no Supabase import)
src/lib/gifenc.d.ts        Types for the parts of gifenc we use
src/lib/prefetch.ts        prefetch(tasks, limit=6): start downloads in order, N at a time, one promise per task
src/lib/flipbookPdf.ts     makeFlipbookPdf → PDF Blob (A4 2×5 / Letter 2×4 cells of 3×2 in, grey cut lines, crop marks,
                           vertical page numbers in the binding margin, header + instructions footer, Latin-1 text only)
src/lib/download.ts        downloadBlob(blob, filename)
src/lib/format.ts          DAY_MS, formatDate, formatDateTime, daysLeft, publicLink
src/lib/slug.ts            randomSlug(): 10 chars, no look-alike characters

src/components/ui.tsx      Button (primary|secondary|ghost|danger), Spinner, Card, ErrorText, Badge
src/components/useAuth.ts  Supabase session hook (undefined = loading, null = logged out)
src/components/RequireAuth.tsx, SetupNotice.tsx, AdminLayout.tsx
src/components/AdminImage.tsx   <img> for admin-only photos (fetched as blob with auth header)
src/components/Uploader.tsx     Drag/drop + picker: images → resize + upload (concurrency 2); a video → onVideo(file)
src/components/VideoImporter.tsx  Video → pages: preview, fps detection, pages/s select, trim, page design + cover
                                (`flipbook:design`, `flipbook:cover`), auto/pick mode (`flipbook:rate`, `flipbook:mode`),
                                extract, review grid, createTake + upload (concurrency 4), then updateTake + MP4 from the
                                in-memory frames + uploadTakeVideo
src/components/FlipbookPlayer.tsx Animated page player (preloads, tap = play/pause, slider = flip). No Supabase import (gallery uses it)
src/components/TakeCard.tsx     Admin take: designed preview (from thumbs), design select, cover toggle/title/subtitle,
                                "Save design & remake video", Make/Download video, Download GIF, Print PDF (A4/Letter,
                                `flipbook:paper`), delete. `pageLoader()` prefetches full pages per job
src/components/Composer.tsx     Frame picker, slot assignment, live preview, full-res render + upload
src/components/RouteError.tsx  App error page; auto-reloads once (sessionStorage flag) when a lazy chunk fails to load
src/components/QrCode.tsx, SessionStatus.tsx

src/pages/Login.tsx, Sessions.tsx (list + create), SessionDetail.tsx (link/QR, 1 photos & video, 2 flipbook takes,
          3 frame composer, 4 framed results),
          Templates.tsx (frames list + new frame with auto slot detection), Gallery.tsx (public), NotFound.tsx

public/sample-frames/      Sample frames (SVG, transparent holes), listed in SAMPLES in Templates.tsx:
                           classic-strip.svg 600×1800 (4 slots), film-35mm.svg 1200×1800 (3), pastel-party.svg 1200×1800 (6);
                           flipbook designs (kind 'flipbook', 1800×1200, one 16:9 hole, left 300 px = binding margin):
                           flipbook-classic.svg, flipbook-pastel.svg, flipbook-film.svg (dark, opaque sprockets),
                           flipbook-retro.svg (smaller 1248×702 hole inside 70s stripes), flipbook-comic.svg (halftone, burst)
                           The three photo frames were installed into the Supabase project on 2026-11-08, the five
                           flipbook designs on 2026-11-10 (service key: PNG to templates/{id}.png + templates row).
                           SVG rules: width/height attrs, holes cut with a <mask>, decorations that look like holes
                           (e.g. film sprockets) must be opaque, system fonts only (web fonts don't load in <img> SVGs)
```

---

## 5. Data model (Supabase)

```
sessions  id uuid PK, slug text UNIQUE, name text, created_at, expires_at (default now()+10d), purged_at nullable
templates id uuid PK, kind 'photo'|'flipbook', name, width int, height int, overlay_key text, slots jsonb [{x,y,w,h}], created_at
takes     id uuid PK, session_id → sessions ON DELETE CASCADE, fps numeric (actual pages/s), source_name,
          design_template_id → templates ON DELETE SET NULL, cover jsonb {enabled,title,subtitle} | null,
          video_key text | null (rendered MP4), created_at
photos    id uuid PK, session_id → sessions ON DELETE CASCADE, kind 'raw'|'framed'|'frame', storage_key, thumb_key,
          width, height, template_id → templates ON DELETE SET NULL,
          take_id → takes ON DELETE CASCADE + frame_index (page order, 0-based): only for kind 'frame', created_at
```

Session state is derived, not stored: **expired** = `purged_at IS NOT NULL OR expires_at <= now()` (`isExpired()`).
`purged_at` set = files are gone; UI disables extend/upload.

**RLS**: `authenticated` has full access to `sessions` and `templates`, **select only** on `photos` and `takes`
(takes and their frames are written by the API).
`anon` has nothing. The API uses the service role. Because "authenticated == staff", **public sign-ups must be
disabled** in Supabase; `ADMIN_EMAILS` is an extra allowlist enforced by the API only (not by RLS).

Schema changes: edit `supabase/schema.sql` keeping it **idempotent** (`if not exists`, `drop policy if exists`),
update types in `src/lib/shared.ts`, and note in both docs that the SQL must be re-run.

### Storage layout (bucket `photos`, `storageKeys` in shared.ts)
```
sessions/{sessionId}/{raw|framed|frame}/{photoId}.jpg
sessions/{sessionId}/{raw|framed|frame}/{photoId}_thumb.jpg
templates/{templateId}.png
sessions/{sessionId}/frame/{takeId}.mp4          (rendered flipbook video, overwritten on re-render)
```
Deleting a session = list + remove the `sessions/{id}/raw`, `/framed` and `/frame` folders (`deleteSessionFiles`;
Supabase `list()` is one level deep, so new kinds need adding there). Bucket limits: 25 MB per file, JPEG/PNG only.
An older schema had `photos.r2_key`; `schema.sql` renames it to `storage_key` if present.

---

## 6. API (`server/app.ts`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | `{ok, error?}`; 503 if env missing |
| GET | `/api/public/sessions/:slug` | none | `PublicSession`: `{status:'ok', name, expires_at, photos[] (incl. take_id, frame_index), takes: PublicTake[] ({id, fps, cover, design: {id,width,height,slots}|null, has_video})}` or `{status:'expired', …}`; 404 unknown |
| GET | `/api/public/photos/:id/:variant(full\|thumb)[?download=1]` | none | Streams from storage; **410 if expired** |
| GET | `/api/templates/:id/overlay` | none | Frame PNG (needed same-origin for canvas) |
| GET | `/api/admin/photos/:id/:variant` | staff | Same as public but ignores expiry |
| POST | `/api/admin/sessions/:id/photos` | staff | multipart `full`, `thumb` (image/jpeg), `kind`, `width`, `height`, `template_id?`; for `kind=frame` also `take_id` (must belong to the session) + `frame_index` (0…239) → photo row |
| POST | `/api/admin/sessions/:id/takes` | staff | JSON `{fps (1–60), source_name}` → take row |
| DELETE | `/api/admin/takes/:id` | staff | All its frame files + video, then the take (frame rows cascade) |
| PATCH | `/api/admin/takes/:id` | staff | JSON `{design_template_id?: uuid|null (must be kind 'flipbook'), cover?: {enabled,title≤80,subtitle≤80}|null}`; **deletes the old video** (`video_key` → null) because it no longer matches |
| POST | `/api/admin/takes/:id/video` | staff | multipart `video` (video/mp4, ≤4 MB) → upsert at the take's key, sets `video_key` |
| GET | `/api/admin/takes/:id/video` | staff | The MP4 (ignores expiry) |
| GET | `/api/public/takes/:id/video[?download=1]` | none | The MP4; **410 if expired**, 404 if not rendered; supports `Range` (206) |
| DELETE | `/api/admin/photos/:id` | staff | Files + row |
| DELETE | `/api/admin/sessions/:id` | staff | Session folders + row (photos cascade) |
| POST | `/api/admin/templates` | staff | multipart `overlay` (image/png), `name`, `width`, `height`, `slots` (JSON, 1–20) |
| DELETE | `/api/admin/templates/:id` | staff | Overlay file + row (framed photos keep, `template_id` → null) |
| POST | `/api/admin/purge` | staff | Run cleanup now → `{purged}` |
| GET | `/api/cron/purge` | `Authorization: Bearer $CRON_SECRET` | Vercel Cron entry → `{purged}`; 401 if the secret is missing or wrong |

Conventions:
- Routes are a table of `[method, regex, admin, handler]`. Add new routes there; IDs match `([0-9a-f-]{36})`.
- Throw `new HttpError(status, message)` for expected errors; anything else → 500 with the message. Responses are JSON `{error}`.
- "staff" = valid Supabase access token in `Authorization: Bearer …` (checked with `auth.getUser`) and, if
  `ADMIN_EMAILS` is set, email in that list.
- Every `/api` route except `/api/health` returns 503 with a clear message if Supabase env is missing/placeholder.
- When writing files + DB together, remove the uploaded files if anything fails (see `uploadPhoto`, `createTemplate`).
- Storage helpers: `putObject`, `removeObjects` (batches of 100), `serveObject`, `deleteSessionFiles`. All storage access goes
  through these, so switching to R2 later only means changing them (via R2's S3 API with keys in env).
- Cron: `purgeExpired()` is idempotent (Vercel may skip or repeat runs) and handles ≤50 sessions per run whose `expires_at < now - PURGE_GRACE_DAYS`, deletes the session's files and
  photo rows and takes, sets `purged_at`. The session row is kept so the gallery can still say "expired".
- `serveObject` answers `Range: bytes=…` with 206 + `content-range` (iOS Safari won't play `<video>` otherwise).
- `createTemplate` takes `kind`; a `flipbook` design must have exactly one slot (400 otherwise).
- Images are served with `cache-control: private, max-age=3600`. After expiry a cached copy can live up to 1 h on the device. Acceptable.

---

## 7. Frontend flows

### Upload (`Uploader.tsx` → `prepareUpload` → `adminApi.uploadPhoto`)
Camera JPEG → `createImageBitmap(file, {imageOrientation:'from-image'})` (respects EXIF rotation) →
full JPEG at **long edge 2400px, q0.88** + thumb **480px, q0.8** → multipart POST. Concurrency 2, per-file errors listed.

### Video → flipbook (`VideoImporter.tsx`, `lib/video.ts`)
Drop a video (MP4/MOV/WebM; `.mov` with an empty MIME type is detected by extension) → importer opens under the drop zone.
It shows the source fps + duration, a pages-per-second select (8/10/**12**/15/24), start/end trim ("use video position"
copies the preview's current time), and a summary like "every 2nd frame → 12 pages/s → 72 pages". More than
`MAX_TAKE_FRAMES` (240) is blocked. **Auto**: extract → `createTake` → upload all. **Pick**: extract → review grid (tap to
exclude, animated preview of the selection) → upload chosen. `frame_index` is the position among the *uploaded* pages
(contiguous 0…n-1). Partial upload failures keep the take with the pages that made it, and list the failures.
Undecodable files → `VideoReadError` with the H.264 hint (also on a load timeout). Extraction: decoder ≈ 10 ms/frame
(72 pages < 1 s), element fallback ≈ 50 ms/frame. iPhone Camera files (HEVC, 10-bit HDR, portrait rotation) work through
the decoder, including from Safari on the phone itself.

### Flipbook design, video and print (`TakeCard.tsx`, `lib/flipbook*.ts`)
- Preview: thumbs → `renderPage` / `renderCover` at 480 px, debounced 150 ms, so changes show before saving.
- **Save design & remake video**: `updateTake` (server drops the old MP4) → fetch full pages → `makeFlipbookVideo` →
  `uploadTakeVideo`. "Make video" re-renders without changing the design (e.g. after a failed auto-render).
- **Print PDF**: full pages → `renderPrintPage` (900×600 JPEG q0.9) → 3×2 in cells. 72 pages + cover = 8 A4 sheets, ~4 MB,
  <1 s. Fonts on the cover use the page's loaded web fonts (Fraunces/Inter; `document.fonts.load` first).
- **Download GIF**: same pages/design/cover as the video, 720 px, not stored. 48 pages + cover ≈ 2.8 MB in ~5 s.
- With a design, the video shows the whole printed page (incl. the binding margin), so it looks like the physical page.

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
Flipbook takes come first: the stored **MP4** (`<video autoplay loop muted playsinline>`) + **Save video** (phones: fetch, then a
second tap opens the share sheet; computers: `?download=1`). If no video was rendered yet: `FlipbookPlayer` over the
plain thumbs, without a save button. **Save GIF** (always shown) builds the GIF on the device from the thumbs + the take's
design/cover ("Making GIF n/N…"), then the same share-sheet second tap, or a plain download where sharing files isn't
supported. Mac Chrome also supports file sharing, so it gets the share sheet too. Frames are **excluded** from the lightbox, "All shots" and "Save all".
Framed first (served **full size**: few and the hero, thumbs look soft on phones), then raw grid (thumbs); lightbox with keyboard + tap zones + download (`?download=1`).
"Save all": on devices that can share files → fetch all, then a **second tap** opens `navigator.share({files})`
(share needs a fresh user gesture); otherwise zip with `fflate.zipSync(level 0)` and download.

### Sessions
Create inserts `{slug: randomSlug(), name, expires_at: now + SESSION_DAYS}` directly via supabase-js.
Extend: `max(now, expires_at) + 30 days`. Rename via `window.prompt`. Delete via the API.

---

## 8. Conventions

- **pnpm only.** Scripts: `pnpm dev | build | typecheck | lint | preview`. Deploys happen by pushing to `main` (Vercel Git integration).
  Adding deps: `pnpm add` / `pnpm add -D`. If a new dep needs a build script, approve it with
  `pnpm approve-builds <pkg> -y` (writes `allowBuilds` in `pnpm-workspace.yaml`).
- **React Compiler is on**: don't add `useMemo`/`useCallback`/`memo` for performance. Plain `useState` + `useEffect`
  data loading; no global state library. Keep effects cancel-safe (`let alive = true` pattern).
- **Styling**: Tailwind utility classes, stone palette, `font-display` (Fraunces) for headings. Reuse `ui.tsx` primitives
  before writing new button/card styles. Admin is desktop-first; the gallery is **mobile-first**.
- **Types shared with the API go in `src/lib/shared.ts`** (it's included in `tsconfig.server.json`). It must stay
  free of DOM/browser APIs and imports.
- `tsconfig` is split: `tsconfig.app.json` (src), `tsconfig.server.json` (server/app.ts, api/, shared.ts),
  `tsconfig.node.json` (vite.config.ts + server/devApi.ts, `nodenext`: relative imports need the `.ts` extension).
- **Relative imports in `server/` and `api/` use `.js` extensions** (`'../server/app.js'`, `'../src/lib/shared.js'`). The project
  is ESM (`"type": "module"`) and Vercel compiles each TS file separately, so extensionless imports would fail at runtime.
- Component files should only export components (oxlint `only-export-components`); put hooks/helpers in their own files.
- Destructive admin actions use `window.confirm` (prototype-level UX is fine).
- Code comments explain *why*, briefly. No dead code; no placeholder TODO files.

---

## 9. Env & config

`.env` (gitignored) holds everything. Vite exposes only `VITE_*` to the browser bundle; the dev middleware reads **all** keys
with `loadEnv(mode, root, '')` on every request. On Vercel, the same keys are set in Project → Settings → Environment
Variables (`VITE_*` are read at **build** time, so changing them needs a redeploy; the rest are read at runtime via `process.env`).

| Key | Side | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | browser | URL `https://ggdwsnufmpcrcmdcpegz.supabase.co`. Key = **publishable** key `sb_publishable_…` (Settings → API Keys). Placeholders (`YOUR-PROJECT`, `your-…`) are treated as "not configured" → `SetupNotice` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | API | Key = **secret** key `sb_secret_…` (Settings → API Keys). **Never** prefix with `VITE_` |
| `ADMIN_EMAILS` | API | Optional comma-separated allowlist |
| `CRON_SECRET` | API | Random 16+ letters/digits. Vercel Cron sends `Authorization: Bearer <it>`; without it `/api/cron/purge` always returns 401 |
| `PURGE_GRACE_DAYS` | API | Optional, default 3 |

`vercel.json`: `outputDirectory: dist` (without it Vercel 404s everything), rewrites `/api/:path*` → `/api?__path=:path*`
(Vercel also appends `path=`; `api/index.ts` strips both) and everything else → `/index.html` (static files are served first,
so this is the SPA fallback that makes `/admin/...` and `/s/:slug` deep links work). Cron `0 3 * * *` (Hobby: once a day,
anytime in that hour, production only).

Vercel's builder picks the pnpm major from the lockfile (it chose pnpm 9 in a local `vercel build`). Fine so far; if installs
ever break on Vercel, pin `packageManager` in package.json and enable corepack (`ENABLE_EXPERIMENTAL_COREPACK=1`).

Use the new Supabase key format (`sb_publishable_…` / `sb_secret_…`); legacy anon/service_role JWT keys are retired in early 2027.
The env var *names* still say `ANON_KEY` / `SERVICE_ROLE_KEY`; they hold the new keys.

Changing the session length: `SESSION_DAYS` in `shared.ts` **and** the column default in `schema.sql`.

---

## 10. Verifying changes

Always run before saying a change is done:
```bash
pnpm typecheck && pnpm lint && pnpm build
```
Smoke test the API: `pnpm dev`, then `curl localhost:<port>/api/health` (`{"ok":true}`, or 503 "Missing env" without keys),
`/api/nope` (404 JSON), `/api/cron/purge` without the secret (401). `/s/anything` must return the SPA HTML.

Verifying the Vercel build without deploying (done 2026-11-08): write a placeholder `.vercel/project.json`
(`{"projectId":"prj_local_test","orgId":"team_local_test","settings":{"framework":"vite","outputDirectory":"dist"}}`), run
`pnpm dlx vercel@latest build --yes`, inspect `.vercel/output/config.json` (routes, crons) and
`.vercel/output/functions/api/index.func/`, then import `api/index.js` from there with Node and call
`default.fetch(new Request('https://x/api?__path=health'))`. **Delete `.vercel/` afterwards.**

Browser-only code (`src/lib/image.ts`) can't run in Node (no canvas). To test it, serve a temporary HTML page from
`public/` that imports `/src/lib/image.ts`, open it in headless Chrome via the DevTools protocol (`--dump-dom` dumps
before async module code finishes, so poll with `Runtime.evaluate`), then **delete the temp page**. Video extraction test (2026-11-10): ffmpeg makes 6 s 1080p H.264
videos where frame N has a white bar at x = N·5 (`geq=lum='if(between(X,N*5,N*5+4),235,16)'`, at 24, 24000/1001, 30, 60 fps)
plus a random-bytes `broken.mp4`; a temp page in `public/` extracts them and reads the bar position back. Expected at 12/s:
24 → frames 0,2,4…142 (72 pages), 23.976 → same, 30 → 0,3,6…177 (60 pages, 10/s), 60 → 0,5…355 (72), broken →
VideoReadError. Run it through **both** engines (`openVideo(file, url, 'decoder' | 'element')`): the frame lists must
match (they did on 2026-11-10, plus trims and the time-based fallback). iPhone-style files: `libx265` hvc1 8-bit, 10-bit HLG
(`-pix_fmt yuv420p10le`, bt2020/arib-std-b67) and the same with `-display_rotation 90` (→ 1080×1920 pages); a UI run
uploaded the portrait HDR one end to end. iOS Safari itself can't be automated here (no Xcode simulator).
Headless Chrome needs `--autoplay-policy=no-user-gesture-required` for `detectFps`. Expected results on the
samples: classic-strip → 4 slots ≈ `{33,33,534,378}`…; film-35mm → 3 ≈ `{147,57,906,492}`…;
pastel-party → 6 ≈ `{57,237,531,456}`… (detected boxes are ~3px larger than the holes on purpose).

End-to-end against the real project (2026-11-08: 46 checks; 2026-11-10 with flipbook: 79; with design/video/PDF:
**102 checks** = setup 8, API 15, admin+gallery UI 14, flipbook API 16, design+video API 21, flipbook UI 19, lifecycle 9).
The design/video API phase creates a 1-hole 900×600 flipbook design PNG and keeps its id in the state file so the UI phase
can pick it; cleanup deletes it. The UI phase uses CDP `Page.setDownloadBehavior` to capture the PDF/MP4 downloads and
ffprobes the MP4 (cover + 72 pages = 73 frames, 7.5 s).
GIF test (2026-11-10, 17 checks + a no-share run, read-only on the owner's session with a temp staff user): gallery Save GIF
→ "Tap to save GIF" (headless Chrome on macOS supports file sharing) → stub `navigator.share` to capture the File → ffprobe
(frames = pages + cover, duration = 1 + pages/fps + 0.5, 600×400 with a design); the download path is tested by deleting
`Navigator.prototype.canShare/share` in `Page.addScriptToEvaluateOnNewDocument`; staff Download GIF → 720×480; Print PDF
still works with prefetching. Method, if you repeat it:
- Use a **temporary staff user** created with the service key (`auth.admin.createUser`, `email_confirm: true`) and sign in
  with the publishable key. Never ask for or use the owner's password. **Delete the user and all test rows/files after.**
- Test scripts and fixtures live in the scratchpad, not the repo. Run Node scripts that need `@supabase/supabase-js` from the
  repo root (copy in as a dotfile, run with `node --env-file=.env`, then delete). Real JPEGs: generate PNGs, convert with `sips`.
- API phase: every route, 401/415/404/410 paths, RLS (anon can't read tables, staff can't insert photos, bucket is private),
  expiry → extend → purge → deletes. Browser phase (Chrome via DevTools protocol): log in through the form (React inputs
  need the native value setter + `input` event), Auto-fill + Save framed photo, check composited pixel colours, and the
  gallery at 390px width (images load, no horizontal scroll, lightbox, unknown slug).
- Run your own dev server on a separate port (`pnpm dev --port 5199 --strictPort`) as a tracked background task and stop
  it by task/PID. **Never `pkill` vite or delete `node_modules/.vite`**: the user may have their own dev server running.
- The installed frames are in the project, so the composer opens on "Classic strip"; a UI test must click its own test frame first.
- Flipbook UI test: feed videos with CDP `DOM.setFileInputFiles` on the uploader's `input[type=file]` (a realistic
  `testsrc2` 1080p 24p `.mov` for auto mode, the frame-numbered MP4 for pick mode), then decode the bar positions of the
  uploaded pages to prove order (pick mode leaving out pages 1–2 must give source frames 4, 6, 8…142).
- **Props that seed edit state**: `TakeCard` copies the saved design/cover into local edit state; the importer saves them
  *after* the card mounts, so the card resets its edits when the saved values change (state-from-previous-render
  pattern, `syncedKey`). Without it the card showed stale "unsaved changes" and hid the video status.
- **Object URLs in effects**: create and revoke them in the *same* effect. React's dev double-mount once revoked a URL
  created in `useState` and the importer reported "can't read this video" for a perfectly fine file.

---

## 11. Gotchas

- **Supabase free projects pause after ~1 week of inactivity.** A paused project looks like network errors.
- **Supabase Storage free**: **1 GB** files, **~5 GB/month egress** shared with DB traffic. Every gallery thumbnail and
  download is proxied by the API but still counts as Supabase egress (and as Vercel function traffic). ~20 MB per session → ~50 live sessions.
  Browser resizing keeps photos ~0.5–1 MB; never store camera originals. Upgrade path: Cloudflare R2 (10 GB, free egress).
- `createImageBitmap` on 40+ MP JPEGs uses a lot of memory. Upload concurrency is capped at 2 and bitmaps are `.close()`d.
- Canvas reads (compose, detect) need **same-origin** images. That's why overlays are served through `/api/templates/:id/overlay`.
  Don't switch to public bucket URLs without adding CORS handling + `crossOrigin`.
- `navigator.share` must be called directly from a tap. Hence the two-step "Save all" on phones.
- HEIC isn't decodable in Chrome; the camera shoots JPEG, so uploads accept JPEG/PNG/WebP only.
- New lazy-route dependency? Add it to `optimizeDeps.include` (see §3). (`mediabunny`, `pdf-lib` are there.)
- MP4 encoding needs WebCodecs `VideoEncoder` + H.264 (Chrome/Edge; Safari 17+). Headless Chrome on macOS encodes fine.
- GIFs are big by nature (60 pages ≈ 5 MB at 600 px, ≈ 6.5–10 MB at 720 px; photo-heavy plain pages are the largest) and
  gradients band (256 colours). That's why they are never stored or uploaded (Vercel's 4.5 MB limit would also block them).
- pdf-lib's standard Helvetica is Latin-1 only: `latin1()` strips other characters from titles (emoji etc.).
- **Vercel function region** defaults to US East. Each API call makes several Supabase round trips, so set the function region
  next to the Supabase region (Vercel → Settings → Functions).
- `pnpm preview` serves only static files: `/api` doesn't work there. Use `pnpm dev` for anything that needs the API.
- TypeScript is v7 (`tsc` native). Use `tsc -b` via `pnpm typecheck`.

---

## 12. Roadmap hints (when the user asks)

- **Flipbook printing** is built (print PDF). Possible next steps: other page sizes (ask the client), duplex/back
  pages, choosing the cover image (now: first page), customer-chosen designs.
- **Printing framed photos**: after compositing, print the framed canvas: a print-only page sized to the paper with `@page { size: 4in 6in; margin: 0 }`,
  run the station Chrome with `--kiosk-printing` to skip the dialog. Add the QR code onto the print (the slug exists before compositing).
  Printing must not wait for uploads: compose locally → print → upload in background.
- **Auto-import**: File System Access API on the station PC, poll the tether folder, feed new files into `Uploader`'s pipeline.
- **Customer frame switching** on the gallery: reuse `composeFrame` + public overlay endpoint with the session's raw photos.
- **Payments**: Midtrans/Xendit (QRIS) webhook → a new route in `server/app.ts` → extend `expires_at`.

---

## Docs rule

`README.md` (developer quick start) and `AGENTS.md` (this file) are the two docs to maintain. When you change
behaviour, routes, schema, env keys, scripts, constants or scope, update **both** in the same change. README stays short and
practical; AGENTS.md gets the details and the reasons behind them.

`CLAUDE.md` only contains `@AGENTS.md` (so Claude Code loads this file automatically). Don't add content to it;
put everything here instead.
