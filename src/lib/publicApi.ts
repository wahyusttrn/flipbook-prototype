// Public (no-login) API used by the customer gallery. Kept free of Supabase
// imports so the gallery bundle stays small on phones.
import type { PhotoVariant, PublicSession } from './shared'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const publicApi = {
  async session(slug: string): Promise<PublicSession> {
    const res = await fetch(`/api/public/sessions/${encodeURIComponent(slug)}`)
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`)
    return body
  },
  photoUrl: (id: string, variant: PhotoVariant, download = false) =>
    `/api/public/photos/${id}/${variant}${download ? '?download=1' : ''}`,
  overlayUrl: (templateId: string) => `/api/templates/${templateId}/overlay`,
  takeVideoUrl: (takeId: string, download = false) => `/api/public/takes/${takeId}/video${download ? '?download=1' : ''}`,
}
