import { useEffect, useState } from 'react'
import { adminApi, publicApi } from '../lib/api'
import { composeFrame, decode, loadImage, resizeToJpeg, toBlob } from '../lib/image'
import { THUMB_MAX_EDGE, type Photo, type Template } from '../lib/shared'
import { AdminImage } from './AdminImage'
import { Button, ErrorText, Spinner } from './ui'

const PREVIEW_HEIGHT = 560

const overlays = new Map<string, Promise<HTMLImageElement>>()
function overlayFor(id: string) {
  let p = overlays.get(id)
  if (!p) {
    p = loadImage(publicApi.overlayUrl(id))
    overlays.set(id, p)
  }
  return p
}

/**
 * Pick a frame, tap a slot, tap a photo to put it there. Saving renders the
 * frame at full template resolution and uploads it as a "framed" photo.
 */
export function Composer({
  sessionId,
  rawPhotos,
  templates,
  onSaved,
}: {
  sessionId: string
  rawPhotos: Photo[]
  templates: Template[]
  onSaved: (p: Photo) => void
}) {
  const [templateId, setTemplateId] = useState<string | null>(templates[0]?.id ?? null)
  const template = templates.find((t) => t.id === templateId) ?? null
  const [assigned, setAssigned] = useState<(string | null)[]>([])
  const [active, setActive] = useState(0)
  const [preview, setPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // One entry per slot of the current frame (photo id or empty)
  const slotCount = template?.slots.length ?? 0
  const slots = Array.from({ length: slotCount }, (_, i) => assigned[i] ?? null)

  // Live preview from thumbnails (fast); the saved file uses full-size photos.
  const slotsKey = slots.join(',')
  useEffect(() => {
    if (!template) return
    let alive = true
    ;(async () => {
      const overlay = await overlayFor(template.id)
      const ids = slotsKey ? slotsKey.split(',') : []
      const bitmaps = await Promise.all(
        ids.map(async (id) => (id ? decode(await adminApi.photoBlob(id, 'thumb')) : null)),
      )
      const canvas = composeFrame(template, overlay, bitmaps, PREVIEW_HEIGHT / template.height)
      bitmaps.forEach((b) => b?.close())
      if (alive) setPreview(canvas.toDataURL('image/jpeg', 0.85))
    })().catch(setError)
    return () => {
      alive = false
    }
  }, [template, slotsKey])

  function chooseTemplate(id: string) {
    setTemplateId(id)
    setAssigned([])
    setActive(0)
    setPreview(null)
  }

  function assign(photoId: string) {
    const next = [...slots]
    next[active] = photoId
    setAssigned(next)
    // jump to the next empty slot, if any
    const empty = next.findIndex((s, i) => !s && i !== active)
    if (empty >= 0) setActive(empty)
  }

  function autofill() {
    setAssigned(Array.from({ length: slotCount }, (_, i) => rawPhotos[i]?.id ?? null))
  }

  async function save() {
    if (!template) return
    setSaving(true)
    setError(null)
    try {
      const overlay = await overlayFor(template.id)
      const bitmaps = await Promise.all(slots.map(async (id) => (id ? decode(await adminApi.photoBlob(id, 'full')) : null)))
      const canvas = composeFrame(template, overlay, bitmaps)
      bitmaps.forEach((b) => b?.close())
      const full = await toBlob(canvas, 'image/jpeg', 0.92)
      const thumb = await resizeToJpeg(canvas, THUMB_MAX_EDGE, 0.8)
      const photo = await adminApi.uploadPhoto({
        sessionId,
        kind: 'framed',
        full,
        thumb: thumb.blob,
        width: canvas.width,
        height: canvas.height,
        templateId: template.id,
      })
      onSaved(photo)
      setAssigned([])
      setActive(0)
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  if (templates.length === 0) {
    return <p className="text-sm text-stone-500">No frames yet. Add one under Frames first.</p>
  }
  if (rawPhotos.length === 0) {
    return <p className="text-sm text-stone-500">Upload photos first, then pick them for the frame here.</p>
  }

  const filled = slots.filter(Boolean).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => chooseTemplate(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${
              t.id === templateId ? 'bg-stone-900 text-white ring-stone-900' : 'bg-white ring-stone-300 hover:bg-stone-100'
            }`}
          >
            {t.name} <span className="opacity-60">· {t.slots.length}</span>
          </button>
        ))}
      </div>

      {template && (
        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          {/* Preview with clickable slots */}
          <div className="mx-auto">
            <div
              className="relative overflow-hidden rounded-lg shadow-md ring-1 ring-stone-200"
              style={{ height: PREVIEW_HEIGHT, aspectRatio: `${template.width} / ${template.height}` }}
            >
              {preview ? (
                <img src={preview} alt="Frame preview" className="absolute inset-0 size-full" />
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-stone-100">
                  <Spinner />
                </div>
              )}
              {template.slots.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActive(i)}
                  aria-label={`Slot ${i + 1}`}
                  className={`absolute grid place-items-center transition-shadow ${
                    i === active ? 'ring-4 ring-amber-400 ring-inset' : 'hover:ring-2 hover:ring-white/80 hover:ring-inset'
                  }`}
                  style={{
                    left: `${(s.x / template.width) * 100}%`,
                    top: `${(s.y / template.height) * 100}%`,
                    width: `${(s.w / template.width) * 100}%`,
                    height: `${(s.h / template.height) * 100}%`,
                  }}
                >
                  {!slots[i] && (
                    <span className="rounded-full bg-stone-900/70 px-2 py-0.5 text-xs font-medium text-white">
                      {i + 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Photo picker */}
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm text-stone-600">
                Slot <b>{active + 1}</b> selected, so tap a photo to place it. {filled}/{slotCount} filled.
              </p>
              <Button variant="ghost" onClick={autofill}>
                Auto-fill
              </Button>
              <Button variant="ghost" onClick={() => setAssigned([])} disabled={!filled}>
                Clear
              </Button>
            </div>
            <div className="grid max-h-[480px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 xl:grid-cols-5">
              {rawPhotos.map((p) => {
                const at = slots.indexOf(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => assign(p.id)}
                    className={`relative aspect-square overflow-hidden rounded-lg ring-2 ${
                      at >= 0 ? 'ring-amber-400' : 'ring-transparent hover:ring-stone-400'
                    }`}
                  >
                    <AdminImage id={p.id} className="size-full object-cover" />
                    {at >= 0 && (
                      <span className="absolute top-1 left-1 rounded-full bg-amber-400 px-1.5 text-xs font-semibold">
                        {at + 1}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            <ErrorText error={error} />
            <Button onClick={save} disabled={saving || filled === 0} className="w-full sm:w-auto">
              {saving ? 'Rendering…' : filled < slotCount ? `Save framed photo (${slotCount - filled} empty)` : 'Save framed photo'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
