// The server side of the app, host-agnostic (Web Request → Response).
// Used by the Vercel function (api/index.ts) and by `pnpm dev` (Vite middleware in vite.config.ts).
//  - keeps the private Supabase Storage bucket private (photos are only served
//    while a session is not expired)
//  - holds the Supabase service-role key (DB + storage)
//  - runs the daily cleanup of expired sessions (Vercel Cron → /api/cron/purge)
//
// Public:  GET  /api/health
//          GET  /api/public/sessions/:slug
//          GET  /api/public/photos/:id/:variant[?download=1]
//          GET  /api/templates/:id/overlay
// Admin:   GET    /api/admin/photos/:id/:variant
//          POST   /api/admin/sessions/:id/photos   (multipart: full, thumb, kind, width, height, template_id?,
//                                                    take_id + frame_index when kind = 'frame')
//          POST   /api/admin/sessions/:id/takes    (JSON: fps, source_name) → take row
//          DELETE /api/admin/takes/:id             (take + all its frames + video)
//          PATCH  /api/admin/takes/:id             (JSON: design_template_id?, cover?) → clears the old video
//          POST   /api/admin/takes/:id/video       (multipart: video = rendered MP4)
//          GET    /api/admin/takes/:id/video
// Public:  GET    /api/public/takes/:id/video[?download=1]   (Range requests supported: iOS needs them)
//          DELETE /api/admin/photos/:id
//          DELETE /api/admin/sessions/:id
//          POST   /api/admin/templates             (multipart: overlay, name, width, height, slots)
//          DELETE /api/admin/templates/:id
//          POST   /api/admin/purge                 (run the cleanup now)
// Cron:    GET    /api/cron/purge                  (Authorization: Bearer $CRON_SECRET, sent by Vercel Cron)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_TAKE_FRAMES,
  MAX_UPLOAD_BYTES,
  isExpired,
  STORAGE_BUCKET,
  storageKeys,
  type FlipbookCover,
  type PhotoKind,
  type PublicSession,
  type PublicTake,
  type Slot,
  type TemplateKind,
} from '../src/lib/shared.js'

/** Server env (process.env on Vercel, .env via Vite's loadEnv in dev). */
export interface ServerEnv {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  /** Optional comma-separated staff allowlist */
  ADMIN_EMAILS?: string
  /** Days after expiry before files are deleted (default 3) */
  PURGE_GRACE_DAYS?: string
  /** Vercel sends it as `Authorization: Bearer …` on cron requests */
  CRON_SECRET?: string
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } })

function configError(env: ServerEnv): string | null {
  const missing = (['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const).filter((k) => {
    const v = env[k]
    return !v || v.includes('YOUR-PROJECT') || v.startsWith('your-')
  })
  return missing.length ? `Missing env: ${missing.join(', ')} (see .env.example)` : null
}

function db(env: ServerEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function requireAdmin(req: Request, env: ServerEnv, sb: SupabaseClient) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'Not logged in')
  const { data, error } = await sb.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Invalid session')
  const allow = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (allow.length && !allow.includes((data.user.email ?? '').toLowerCase())) {
    throw new HttpError(403, 'Not an admin')
  }
  return data.user
}

// ── Storage helpers (Supabase Storage, private bucket) ─────────────────────

const bucket = (sb: SupabaseClient) => sb.storage.from(STORAGE_BUCKET)

async function putObject(sb: SupabaseClient, key: string, file: Blob, contentType: string, upsert = false) {
  const { error } = await bucket(sb).upload(key, file, { contentType, upsert })
  if (error) throw error
}

async function removeObjects(sb: SupabaseClient, keys: string[]) {
  for (let i = 0; i < keys.length; i += 100) {
    const { error } = await bucket(sb).remove(keys.slice(i, i + 100))
    if (error) throw error
  }
}

async function serveObject(sb: SupabaseClient, key: string, downloadName?: string, range?: string | null) {
  const { data, error } = await bucket(sb).download(key)
  if (error || !data) throw new HttpError(404, 'File not found')
  const headers = new Headers({
    'content-type': data.type || 'application/octet-stream',
    'cache-control': 'private, max-age=3600',
    'accept-ranges': 'bytes',
  })
  if (downloadName) headers.set('content-disposition', `attachment; filename="${downloadName}"`)
  // Byte ranges: Safari/iOS won't play a <video> unless the server answers them with 206.
  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  if (m && (m[1] || m[2])) {
    const size = data.size
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) {
      headers.set('content-range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('content-range', `bytes ${start}-${end}/${size}`)
    return new Response(data.slice(start, end + 1), { status: 206, headers })
  }
  return new Response(data, { headers })
}

/** Delete every file of a session (both raw/ and framed/ folders). */
async function deleteSessionFiles(sb: SupabaseClient, sessionId: string) {
  for (const kind of ['raw', 'framed', 'frame'] as const) {
    const folder = storageKeys.sessionFolder(sessionId, kind)
    for (;;) {
      const { data, error } = await bucket(sb).list(folder, { limit: 1000 })
      if (error) throw error
      if (!data.length) break
      await removeObjects(sb, data.map((f) => `${folder}/${f.name}`))
      if (data.length < 1000) break
    }
  }
}

function fileField(form: FormData, name: string, types: string[]): File {
  const v = form.get(name)
  if (!(v instanceof File)) throw new HttpError(400, `Missing file "${name}"`)
  if (!types.includes(v.type)) throw new HttpError(415, `"${name}" must be ${types.join(' or ')}`)
  if (v.size > MAX_UPLOAD_BYTES) throw new HttpError(413, `"${name}" is too large`)
  return v
}

function intField(form: FormData, name: string): number {
  const n = Number(form.get(name))
  if (!Number.isInteger(n) || n <= 0 || n > 20000) throw new HttpError(400, `Invalid "${name}"`)
  return n
}

function safeFilename(s: string) {
  return s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'photo'
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function getPublicSession(sb: SupabaseClient, slug: string): Promise<Response> {
  const { data: s, error } = await sb
    .from('sessions')
    .select('id, name, expires_at, purged_at')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  if (!s) throw new HttpError(404, 'Session not found')

  if (isExpired(s)) {
    return json({ status: 'expired', name: s.name, expires_at: s.expires_at } satisfies PublicSession)
  }
  const [{ data: photos, error: pErr }, { data: takes, error: tErr }] = await Promise.all([
    sb
      .from('photos')
      .select('id, kind, width, height, take_id, frame_index')
      .eq('session_id', s.id)
      .order('created_at')
      .order('frame_index', { nullsFirst: true }),
    sb
      .from('takes')
      .select('id, fps, cover, video_key, design:templates(id, width, height, slots)')
      .eq('session_id', s.id)
      .order('created_at'),
  ])
  if (pErr) throw pErr
  if (tErr) throw tErr
  const publicTakes: PublicTake[] = (takes ?? []).map((t) => ({
    id: t.id,
    fps: Number(t.fps),
    cover: t.cover as FlipbookCover | null,
    design: (t.design as unknown as PublicTake['design']) ?? null,
    has_video: !!t.video_key,
  }))
  return json({ status: 'ok', name: s.name, expires_at: s.expires_at, photos, takes: publicTakes } satisfies PublicSession)
}

async function loadPhoto(sb: SupabaseClient, id: string) {
  const { data, error } = await sb
    .from('photos')
    .select('id, kind, storage_key, thumb_key, sessions!inner(name, expires_at, purged_at)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Photo not found')
  const session = data.sessions as unknown as { name: string; expires_at: string; purged_at: string | null }
  return { ...data, session }
}

async function servePhoto(sb: SupabaseClient, id: string, variant: string, url: URL, publicAccess: boolean) {
  const photo = await loadPhoto(sb, id)
  if (publicAccess && isExpired(photo.session)) throw new HttpError(410, 'This session has expired')
  const key = variant === 'thumb' ? photo.thumb_key : photo.storage_key
  const download = url.searchParams.has('download')
    ? `${safeFilename(photo.session.name)}-${photo.kind}-${photo.id.slice(0, 8)}.jpg`
    : undefined
  return serveObject(sb, key, download)
}

async function uploadPhoto(req: Request, sb: SupabaseClient, sessionId: string) {
  const { data: s, error } = await sb.from('sessions').select('id, purged_at').eq('id', sessionId).maybeSingle()
  if (error) throw error
  if (!s) throw new HttpError(404, 'Session not found')
  if (s.purged_at) throw new HttpError(410, 'Session files were already deleted')

  const form = await req.formData()
  const kind = form.get('kind') as PhotoKind
  if (kind !== 'raw' && kind !== 'framed' && kind !== 'frame') throw new HttpError(400, 'Invalid "kind"')
  const full = fileField(form, 'full', ['image/jpeg'])
  const thumb = fileField(form, 'thumb', ['image/jpeg'])
  const width = intField(form, 'width')
  const height = intField(form, 'height')
  const templateId = (form.get('template_id') as string | null) || null
  let takeId: string | null = null
  let frameIndex: number | null = null
  if (kind === 'frame') {
    takeId = String(form.get('take_id') ?? '')
    // Check the format here: an invalid uuid would otherwise surface as a 500 from Postgres.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(takeId)) {
      throw new HttpError(400, 'Missing or invalid "take_id"')
    }
    frameIndex = Number(form.get('frame_index'))
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= MAX_TAKE_FRAMES) {
      throw new HttpError(400, 'Invalid "frame_index"')
    }
    const { data: take, error: tErr } = await sb.from('takes').select('session_id').eq('id', takeId).maybeSingle()
    if (tErr) throw tErr
    if (!take || take.session_id !== sessionId) throw new HttpError(400, 'Invalid "take_id"')
  }

  const id = crypto.randomUUID()
  const storage_key = storageKeys.photo(sessionId, kind, id)
  const thumb_key = storageKeys.thumb(sessionId, kind, id)
  try {
    await Promise.all([
      putObject(sb, storage_key, full, 'image/jpeg'),
      putObject(sb, thumb_key, thumb, 'image/jpeg'),
    ])
  } catch (e) {
    await removeObjects(sb, [storage_key, thumb_key]).catch(() => {})
    throw e
  }

  const { data: row, error: insErr } = await sb
    .from('photos')
    .insert({
      id,
      session_id: sessionId,
      kind,
      storage_key,
      thumb_key,
      width,
      height,
      template_id: templateId,
      take_id: takeId,
      frame_index: frameIndex,
    })
    .select()
    .single()
  if (insErr) {
    await removeObjects(sb, [storage_key, thumb_key]).catch(() => {})
    throw insErr
  }
  return json(row, 201)
}

async function createTake(req: Request, sb: SupabaseClient, sessionId: string) {
  const { data: s, error } = await sb.from('sessions').select('id, purged_at').eq('id', sessionId).maybeSingle()
  if (error) throw error
  if (!s) throw new HttpError(404, 'Session not found')
  if (s.purged_at) throw new HttpError(410, 'Session files were already deleted')
  const body = (await req.json().catch(() => null)) as { fps?: unknown; source_name?: unknown } | null
  const fps = Number(body?.fps)
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new HttpError(400, 'fps must be between 1 and 60')
  const source_name = String(body?.source_name ?? '').slice(0, 200)
  const { data, error: insErr } = await sb.from('takes').insert({ session_id: sessionId, fps, source_name }).select().single()
  if (insErr) throw insErr
  return json(data, 201)
}

async function deleteTake(sb: SupabaseClient, id: string) {
  const { data: frames, error } = await sb.from('photos').select('storage_key, thumb_key').eq('take_id', id)
  if (error) throw error
  const { data: take } = await sb.from('takes').select('video_key').eq('id', id).maybeSingle()
  await removeObjects(sb, [
    ...(frames ?? []).flatMap((f) => [f.storage_key, f.thumb_key]),
    ...(take?.video_key ? [take.video_key] : []),
  ])
  const { data: gone, error: delErr } = await sb.from('takes').delete().eq('id', id).select('id') // frames cascade
  if (delErr) throw delErr
  if (!gone?.length) throw new HttpError(404, 'Take not found')
  return json({ ok: true })
}

async function loadTake(sb: SupabaseClient, id: string) {
  const { data, error } = await sb
    .from('takes')
    .select('id, session_id, video_key, sessions!inner(name, expires_at, purged_at)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Take not found')
  const session = data.sessions as unknown as { name: string; expires_at: string; purged_at: string | null }
  return { ...data, session }
}

function parseCover(raw: unknown): FlipbookCover | null {
  if (raw === null) return null
  const c = (raw ?? {}) as Record<string, unknown>
  return {
    enabled: c.enabled === true,
    title: String(c.title ?? '').slice(0, 80),
    subtitle: String(c.subtitle ?? '').slice(0, 80),
  }
}

/** Change a take's design/cover. The old video no longer matches, so it's removed; the studio PC re-renders it. */
async function updateTake(req: Request, sb: SupabaseClient, id: string) {
  const take = await loadTake(sb, id)
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) throw new HttpError(400, 'JSON body required')
  const patch: Record<string, unknown> = {}
  if ('design_template_id' in body) {
    const tid = body.design_template_id
    if (tid !== null) {
      const { data: t, error } = await sb.from('templates').select('kind').eq('id', String(tid)).maybeSingle()
      if (error) throw new HttpError(400, 'Invalid "design_template_id"')
      if (!t || t.kind !== 'flipbook') throw new HttpError(400, 'Design must be a flipbook page template')
    }
    patch.design_template_id = tid
  }
  if ('cover' in body) patch.cover = parseCover(body.cover)
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update')
  if (take.video_key) {
    await removeObjects(sb, [take.video_key])
    patch.video_key = null
  }
  const { data, error } = await sb.from('takes').update(patch).eq('id', id).select().single()
  if (error) throw error
  return json(data)
}

async function uploadTakeVideo(req: Request, sb: SupabaseClient, id: string) {
  const take = await loadTake(sb, id)
  if (take.session.purged_at) throw new HttpError(410, 'Session files were already deleted')
  const video = fileField(await req.formData(), 'video', ['video/mp4'])
  const key = storageKeys.takeVideo(take.session_id, id)
  await putObject(sb, key, video, 'video/mp4', true)
  const { data, error } = await sb.from('takes').update({ video_key: key }).eq('id', id).select().single()
  if (error) throw error
  return json(data)
}

async function serveTakeVideo(req: Request, sb: SupabaseClient, id: string, url: URL, publicAccess: boolean) {
  const take = await loadTake(sb, id)
  if (publicAccess && isExpired(take.session)) throw new HttpError(410, 'This session has expired')
  if (!take.video_key) throw new HttpError(404, 'Video not rendered yet')
  const download = url.searchParams.has('download') ? `${safeFilename(take.session.name)}-flipbook.mp4` : undefined
  return serveObject(sb, take.video_key, download, req.headers.get('range'))
}

async function deletePhoto(sb: SupabaseClient, id: string) {
  const { data, error } = await sb.from('photos').select('storage_key, thumb_key').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Photo not found')
  await removeObjects(sb, [data.storage_key, data.thumb_key])
  const { error: delErr } = await sb.from('photos').delete().eq('id', id)
  if (delErr) throw delErr
  return json({ ok: true })
}

async function deleteSession(sb: SupabaseClient, id: string) {
  await deleteSessionFiles(sb, id)
  const { error } = await sb.from('sessions').delete().eq('id', id) // photos cascade
  if (error) throw error
  return json({ ok: true })
}

function parseSlots(raw: unknown, width: number, height: number): Slot[] {
  let slots: unknown
  try {
    slots = JSON.parse(String(raw))
  } catch {
    throw new HttpError(400, 'Invalid "slots" JSON')
  }
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 20) {
    throw new HttpError(400, 'A template needs 1–20 slots')
  }
  return slots.map((s, i) => {
    const { x, y, w, h } = (s ?? {}) as Record<string, unknown>
    const nums = [x, y, w, h].map(Number)
    if (nums.some((n) => !Number.isFinite(n)) || nums[2] <= 0 || nums[3] <= 0 || nums[0] + nums[2] > width + 2 || nums[1] + nums[3] > height + 2) {
      throw new HttpError(400, `Slot ${i + 1} is outside the template`)
    }
    const [sx, sy, sw, sh] = nums.map(Math.round)
    return { x: sx, y: sy, w: sw, h: sh }
  })
}

async function createTemplate(req: Request, sb: SupabaseClient) {
  const form = await req.formData()
  const overlay = fileField(form, 'overlay', ['image/png'])
  const name = String(form.get('name') ?? '').trim()
  if (!name) throw new HttpError(400, 'Template name is required')
  const width = intField(form, 'width')
  const height = intField(form, 'height')
  const slots = parseSlots(form.get('slots'), width, height)
  const kind: TemplateKind = form.get('kind') === 'flipbook' ? 'flipbook' : 'photo'
  if (kind === 'flipbook' && slots.length !== 1) {
    throw new HttpError(400, 'A flipbook page design needs exactly one photo area')
  }

  const id = crypto.randomUUID()
  const overlay_key = storageKeys.template(id)
  await putObject(sb, overlay_key, overlay, 'image/png')
  const { data, error } = await sb
    .from('templates')
    .insert({ id, kind, name, width, height, overlay_key, slots })
    .select()
    .single()
  if (error) {
    await removeObjects(sb, [overlay_key]).catch(() => {})
    throw error
  }
  return json(data, 201)
}

async function deleteTemplate(sb: SupabaseClient, id: string) {
  const { data, error } = await sb.from('templates').select('overlay_key').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Template not found')
  await removeObjects(sb, [data.overlay_key])
  const { error: delErr } = await sb.from('templates').delete().eq('id', id)
  if (delErr) throw delErr
  return json({ ok: true })
}

async function serveOverlay(sb: SupabaseClient, id: string) {
  const { data, error } = await sb.from('templates').select('overlay_key').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Template not found')
  return serveObject(sb, data.overlay_key)
}

/** Delete stored files of sessions that expired more than PURGE_GRACE_DAYS ago. */
export async function purgeExpired(env: ServerEnv) {
  const sb = db(env)
  const graceDays = Number(env.PURGE_GRACE_DAYS) || 3
  const cutoff = new Date(Date.now() - graceDays * 86_400_000).toISOString()
  const { data: sessions, error } = await sb
    .from('sessions')
    .select('id')
    .is('purged_at', null)
    .lt('expires_at', cutoff)
    .limit(50)
  if (error) throw error

  for (const s of sessions ?? []) {
    await deleteSessionFiles(sb, s.id)
    await sb.from('photos').delete().eq('session_id', s.id)
    await sb.from('takes').delete().eq('session_id', s.id)
    await sb.from('sessions').update({ purged_at: new Date().toISOString() }).eq('id', s.id)
  }
  console.log(`purge: ${sessions?.length ?? 0} session(s) cleaned`)
  return sessions?.length ?? 0
}

// ── Router ────────────────────────────────────────────────────────────────

const UUID = '([0-9a-f-]{36})'
const routes: [method: string, pattern: RegExp, admin: boolean, handler: (ctx: {
  req: Request
  env: ServerEnv
  sb: SupabaseClient
  url: URL
  p: string[]
}) => Promise<Response>][] = [
  ['GET', /^\/api\/public\/sessions\/([\w-]{4,64})$/, false, ({ sb, p }) => getPublicSession(sb, p[0])],
  ['GET', new RegExp(`^/api/public/photos/${UUID}/(full|thumb)$`), false, ({ sb, p, url }) => servePhoto(sb, p[0], p[1], url, true)],
  ['GET', new RegExp(`^/api/templates/${UUID}/overlay$`), false, ({ sb, p }) => serveOverlay(sb, p[0])],
  ['GET', new RegExp(`^/api/admin/photos/${UUID}/(full|thumb)$`), true, ({ sb, p, url }) => servePhoto(sb, p[0], p[1], url, false)],
  ['POST', new RegExp(`^/api/admin/sessions/${UUID}/photos$`), true, ({ req, sb, p }) => uploadPhoto(req, sb, p[0])],
  ['POST', new RegExp(`^/api/admin/sessions/${UUID}/takes$`), true, ({ req, sb, p }) => createTake(req, sb, p[0])],
  ['DELETE', new RegExp(`^/api/admin/takes/${UUID}$`), true, ({ sb, p }) => deleteTake(sb, p[0])],
  ['PATCH', new RegExp(`^/api/admin/takes/${UUID}$`), true, ({ req, sb, p }) => updateTake(req, sb, p[0])],
  ['POST', new RegExp(`^/api/admin/takes/${UUID}/video$`), true, ({ req, sb, p }) => uploadTakeVideo(req, sb, p[0])],
  ['GET', new RegExp(`^/api/admin/takes/${UUID}/video$`), true, ({ req, sb, p, url }) => serveTakeVideo(req, sb, p[0], url, false)],
  ['GET', new RegExp(`^/api/public/takes/${UUID}/video$`), false, ({ req, sb, p, url }) => serveTakeVideo(req, sb, p[0], url, true)],
  ['DELETE', new RegExp(`^/api/admin/photos/${UUID}$`), true, ({ sb, p }) => deletePhoto(sb, p[0])],
  ['DELETE', new RegExp(`^/api/admin/sessions/${UUID}$`), true, ({ sb, p }) => deleteSession(sb, p[0])],
  ['POST', /^\/api\/admin\/templates$/, true, ({ req, sb }) => createTemplate(req, sb)],
  ['DELETE', new RegExp(`^/api/admin/templates/${UUID}$`), true, ({ sb, p }) => deleteTemplate(sb, p[0])],
  ['POST', /^\/api\/admin\/purge$/, true, async ({ env }) => json({ purged: await purgeExpired(env) })],
]

/**
 * Handle one /api request. `url` defaults to the request URL; the Vercel entry passes the
 * original path explicitly because its rewrite moves the path into a query parameter.
 */
export async function handleApi(req: Request, env: ServerEnv, url = new URL(req.url)): Promise<Response> {
  try {
    if (url.pathname === '/api/health') {
      const err = configError(env)
      return json({ ok: !err, error: err ?? undefined }, err ? 503 : 200)
    }
    if (url.pathname === '/api/cron/purge' && req.method === 'GET') {
      if (!env.CRON_SECRET || req.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
        throw new HttpError(401, 'Unauthorized')
      }
      return json({ purged: await purgeExpired(env) })
    }
    for (const [method, pattern, admin, handler] of routes) {
      const m = url.pathname.match(pattern)
      if (!m || req.method !== method) continue
      const err = configError(env)
      if (err) throw new HttpError(503, err)
      const sb = db(env)
      if (admin) await requireAdmin(req, env, sb)
      return await handler({ req, env, sb, url, p: m.slice(1) })
    }
    throw new HttpError(404, 'Not found')
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    console.error(e)
    const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Internal error'
    return json({ error: message }, 500)
  }
}
