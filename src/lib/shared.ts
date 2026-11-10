// Types + constants shared by the React app and the API (server/app.ts).

/** raw = camera photo, framed = composited frame, frame = one flipbook page sampled from a video take */
export type PhotoKind = 'raw' | 'framed' | 'frame'
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

/** photo = frame for the photo composer; flipbook = page design applied on top of flipbook pages */
export type TemplateKind = 'photo' | 'flipbook'

export interface Template {
  id: string
  kind: TemplateKind
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
  /** Only for kind 'frame' */
  take_id: string | null
  frame_index: number | null
  created_at: string
}

/** One video import: its frames are photos with kind 'frame' and this take_id. */
export interface Take {
  id: string
  session_id: string
  fps: number
  source_name: string
  /** Flipbook page design (template of kind 'flipbook'); null = plain pages */
  design_template_id: string | null
  cover: FlipbookCover | null
  /** Rendered MP4 in storage; null until the studio PC has made it */
  video_key: string | null
  created_at: string
}

/** Optional first page with the customer's name and date */
export interface FlipbookCover {
  enabled: boolean
  title: string
  subtitle: string
}

/** What the gallery needs to show and design a take */
export interface PublicTake {
  id: string
  fps: number
  cover: FlipbookCover | null
  design: Pick<Template, 'id' | 'width' | 'height' | 'slots'> | null
  has_video: boolean
}

/** What the public gallery endpoint returns. */
export type PublicSession =
  | {
      status: 'ok'
      name: string
      expires_at: string
      photos: Pick<Photo, 'id' | 'kind' | 'width' | 'height' | 'take_id' | 'frame_index'>[]
      takes: PublicTake[]
    }
  | { status: 'expired'; name: string; expires_at: string }

/** How long a new session's public link stays valid. */
export const SESSION_DAYS = 10

/** Long edge (px) of stored raw photos. Enough for a 4R print at 300 DPI. */
export const RAW_MAX_EDGE = 2400
/** Long edge (px) of thumbnails used in grids. */
export const THUMB_MAX_EDGE = 480
/** Long edge (px) of stored flipbook frames. Video is ≤1080p anyway; a flipbook page is ~3×2" (900px at 300 DPI). */
export const FRAME_MAX_EDGE = 1920
/** Default sampling rate. 12 lands exactly on frames of 24 and 60 fps video (every 2nd / 5th). */
export const DEFAULT_FLIPBOOK_FPS = 12
/** Safety cap per take (20 s at 12 fps), so a long video isn't turned into thousands of uploads. */
export const MAX_TAKE_FRAMES = 240
/** Printed flipbook page: 3×2 in, landscape, bound on the left with a 0.5 in margin (300 DPI → 900×600 px). */
export const FLIPBOOK_PAGE = { widthIn: 3, heightIn: 2, bindingIn: 0.5, dpi: 300 } as const
/** How long the cover is shown at the start of the flipbook video */
export const COVER_SECONDS = 1
/** Hold the last page a moment (video and GIF) so the loop has a beat before restarting */
export const END_HOLD_SECONDS = 0.5
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
  takeVideo: (sessionId: string, takeId: string) => `sessions/${sessionId}/frame/${takeId}.mp4`,
}

export function isExpired(s: Pick<Session, 'expires_at' | 'purged_at'>, now = Date.now()) {
  return s.purged_at !== null || new Date(s.expires_at).getTime() <= now
}
