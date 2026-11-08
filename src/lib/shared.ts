// Types + constants shared by the React app and the API (server/app.ts).

export type PhotoKind = 'raw' | 'framed'
export type PhotoVariant = 'full' | 'thumb'

/** A photo hole in a frame template, in template pixels. */
export interface Slot {
  x: number
  y: number
  w: number
  h: number
}

export interface Session {
  id: string
  slug: string
  name: string
  created_at: string
  expires_at: string
  purged_at: string | null
}

export interface Template {
  id: string
  name: string
  width: number
  height: number
  overlay_key: string
  slots: Slot[]
  created_at: string
}

export interface Photo {
  id: string
  session_id: string
  kind: PhotoKind
  storage_key: string
  thumb_key: string
  width: number
  height: number
  template_id: string | null
  created_at: string
}

/** What the public gallery endpoint returns. */
export type PublicSession =
  | {
      status: 'ok'
      name: string
      expires_at: string
      photos: Pick<Photo, 'id' | 'kind' | 'width' | 'height'>[]
    }
  | { status: 'expired'; name: string; expires_at: string }

/** How long a new session's public link stays valid. */
export const SESSION_DAYS = 10

/** Long edge (px) of stored raw photos. Enough for a 4R print at 300 DPI. */
export const RAW_MAX_EDGE = 2400
/** Long edge (px) of thumbnails used in grids. */
export const THUMB_MAX_EDGE = 480
/** Max size per uploaded file. Vercel functions reject request bodies over 4.5 MB (full + thumb together). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/** Private Supabase Storage bucket (created by supabase/schema.sql). Only the API touches it. */
export const STORAGE_BUCKET = 'photos'

export const storageKeys = {
  photo: (sessionId: string, kind: PhotoKind, photoId: string) =>
    `sessions/${sessionId}/${kind}/${photoId}.jpg`,
  thumb: (sessionId: string, kind: PhotoKind, photoId: string) =>
    `sessions/${sessionId}/${kind}/${photoId}_thumb.jpg`,
  sessionFolder: (sessionId: string, kind: PhotoKind) => `sessions/${sessionId}/${kind}`,
  template: (templateId: string) => `templates/${templateId}.png`,
}

export function isExpired(s: Pick<Session, 'expires_at' | 'purged_at'>, now = Date.now()) {
  return s.purged_at !== null || new Date(s.expires_at).getTime() <= now
}
