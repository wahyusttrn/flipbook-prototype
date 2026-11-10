import { ApiError } from './publicApi'
import { supabase } from './supabase'
import type { Photo, PhotoKind, PhotoVariant, Slot, Take, Template } from './shared'

export { ApiError, publicApi } from './publicApi'

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (auth) {
    const { data } = await supabase.auth.getSession()
    if (data.session) headers.set('authorization', `Bearer ${data.session.access_token}`)
  }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`)
  }
  const type = res.headers.get('content-type') ?? ''
  return (type.includes('application/json') ? res.json() : res.blob()) as Promise<T>
}

// ── Admin ─────────────────────────────────────────────────────────────────

export interface UploadPhotoInput {
  sessionId: string
  kind: PhotoKind
  full: Blob
  thumb: Blob
  width: number
  height: number
  templateId?: string
  /** kind 'frame' only */
  takeId?: string
  frameIndex?: number
}

export const adminApi = {
  uploadPhoto(input: UploadPhotoInput) {
    const form = new FormData()
    form.set('kind', input.kind)
    form.set('full', input.full, 'full.jpg')
    form.set('thumb', input.thumb, 'thumb.jpg')
    form.set('width', String(input.width))
    form.set('height', String(input.height))
    if (input.templateId) form.set('template_id', input.templateId)
    if (input.takeId) form.set('take_id', input.takeId)
    if (input.frameIndex !== undefined) form.set('frame_index', String(input.frameIndex))
    return request<Photo>(`/api/admin/sessions/${input.sessionId}/photos`, { method: 'POST', body: form })
  },
  createTake: (sessionId: string, fps: number, sourceName: string) =>
    request<Take>(`/api/admin/sessions/${sessionId}/takes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fps, source_name: sourceName }),
    }),
  deleteTake: (id: string) => request<{ ok: true }>(`/api/admin/takes/${id}`, { method: 'DELETE' }),
  deletePhoto: (id: string) => request<{ ok: true }>(`/api/admin/photos/${id}`, { method: 'DELETE' }),
  deleteSession: (id: string) => request<{ ok: true }>(`/api/admin/sessions/${id}`, { method: 'DELETE' }),
  createTemplate(input: { name: string; overlay: Blob; width: number; height: number; slots: Slot[] }) {
    const form = new FormData()
    form.set('name', input.name)
    form.set('overlay', input.overlay, 'overlay.png')
    form.set('width', String(input.width))
    form.set('height', String(input.height))
    form.set('slots', JSON.stringify(input.slots))
    return request<Template>('/api/admin/templates', { method: 'POST', body: form })
  },
  deleteTemplate: (id: string) => request<{ ok: true }>(`/api/admin/templates/${id}`, { method: 'DELETE' }),
  purgeNow: () => request<{ purged: number }>('/api/admin/purge', { method: 'POST' }),

  /** Admin photos need the auth header, so they're fetched as blobs (cached per page load). */
  photoBlob(id: string, variant: PhotoVariant): Promise<Blob> {
    const k = `${id}/${variant}`
    let p = blobCache.get(k)
    if (!p) {
      p = request<Blob>(`/api/admin/photos/${k}`)
      p.catch(() => blobCache.delete(k))
      blobCache.set(k, p)
    }
    return p
  },
}

const blobCache = new Map<string, Promise<Blob>>()
