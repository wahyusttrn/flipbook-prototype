import { useEffect, useState, type CSSProperties } from 'react'
import { Button, Card, ErrorText, Spinner } from '../components/ui'
import { adminApi, publicApi } from '../lib/api'
import { detectSlots, loadImage, toBlob } from '../lib/image'
import type { Slot, Template, TemplateKind } from '../lib/shared'
import { supabase } from '../lib/supabase'

const SAMPLES: { name: string; url: string; kind: TemplateKind }[] = [
  { name: 'Classic strip', url: '/sample-frames/classic-strip.svg', kind: 'photo' },
  { name: 'Film 35mm', url: '/sample-frames/film-35mm.svg', kind: 'photo' },
  { name: 'Pastel party', url: '/sample-frames/pastel-party.svg', kind: 'photo' },
  { name: 'Flipbook classic', url: '/sample-frames/flipbook-classic.svg', kind: 'flipbook' },
  { name: 'Flipbook pastel', url: '/sample-frames/flipbook-pastel.svg', kind: 'flipbook' },
  { name: 'Flipbook film', url: '/sample-frames/flipbook-film.svg', kind: 'flipbook' },
  { name: 'Flipbook retro', url: '/sample-frames/flipbook-retro.svg', kind: 'flipbook' },
  { name: 'Flipbook comic', url: '/sample-frames/flipbook-comic.svg', kind: 'flipbook' },
]

const KIND_LABEL: Record<TemplateKind, string> = { photo: 'Photo frames', flipbook: 'Flipbook page designs' }

export function Templates() {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    supabase
      .from('templates')
      .select('*')
      .order('created_at')
      .then(({ data, error }) => (error ? setError(error) : setTemplates(data)))
  }, [])

  async function remove(t: Template) {
    const what = t.kind === 'flipbook' ? 'Takes using it go back to plain pages (re-make their video).' : 'Photos already framed with it are kept.'
    if (!window.confirm(`Delete "${t.name}"? ${what}`)) return
    try {
      await adminApi.deleteTemplate(t.id)
      setTemplates((all) => all?.filter((x) => x.id !== t.id) ?? null)
    } catch (e) {
      setError(e)
    }
  }

  return (
    <div className="space-y-6">
      <NewTemplate onCreated={(t) => setTemplates((all) => [...(all ?? []), t])} />
      <ErrorText error={error} />
      {!templates ? (
        <Spinner />
      ) : (
        (['photo', 'flipbook'] as const).map((kind) => {
          const list = templates.filter((t) => t.kind === kind)
          return (
            <section key={kind} className="space-y-3">
              <h1 className="font-display text-2xl">
                {KIND_LABEL[kind]} <span className="text-base text-stone-400">({list.length})</span>
              </h1>
              {list.length === 0 ? (
                <p className="text-sm text-stone-500">None yet.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  {list.map((t) => (
                    <div key={t.id} className="space-y-2">
                      <img
                        src={publicApi.overlayUrl(t.id)}
                        alt={t.name}
                        className="checker w-full rounded-lg object-contain ring-1 ring-stone-200"
                        style={{ aspectRatio: `${t.width} / ${t.height}` }}
                      />
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{t.name}</p>
                          <p className="text-xs text-stone-500">
                            {t.width}×{t.height}px{t.kind === 'photo' ? ` · ${t.slots.length} photos` : ''}
                          </p>
                        </div>
                        <button type="button" onClick={() => remove(t)} className="text-xs text-red-700 hover:underline">
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}

interface Draft {
  name: string
  kind: TemplateKind
  png: Blob
  previewUrl: string
  width: number
  height: number
  slots: Slot[]
}

/** Upload a PNG/SVG frame with transparent holes → slots are detected automatically. */
function NewTemplate({ onCreated }: { onCreated: (t: Template) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function load(src: string, name: string, kind: TemplateKind) {
    setError(null)
    try {
      const img = await loadImage(src)
      const width = img.naturalWidth
      const height = img.naturalHeight
      if (!width || !height) throw new Error('Could not read the image size (SVGs need width and height attributes).')
      // Rasterise to PNG at native size so SVG/WebP all end up the same.
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      c.getContext('2d')!.drawImage(img, 0, 0)
      const slots = detectSlots(c)
      const png = await toBlob(c, 'image/png')
      setDraft({ name, kind, png, previewUrl: URL.createObjectURL(png), width, height, slots })
      if (!slots.length) setError('No transparent holes found. The photo areas must be transparent in the PNG.')
    } catch (e) {
      setError(e)
    }
  }

  function updateSlot(i: number, key: keyof Slot, value: number) {
    setDraft((d) => d && { ...d, slots: d.slots.map((s, j) => (j === i ? { ...s, [key]: value } : s)) })
  }

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const t = await adminApi.createTemplate({
        name: draft.name.trim() || 'Untitled frame',
        kind: draft.kind,
        overlay: draft.png,
        width: draft.width,
        height: draft.height,
        slots: draft.slots,
      })
      onCreated(t)
      setDraft(null)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display mr-auto text-xl">Add a frame or flipbook design</h2>
        <label className="inline-flex cursor-pointer items-center rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-stone-700">
          Upload PNG / SVG
          <input
            type="file"
            accept="image/png,image/svg+xml,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) load(URL.createObjectURL(f), f.name.replace(/\.\w+$/, ''), 'photo')
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm text-stone-500">Samples:</span>
        {SAMPLES.map((s) => (
          <button
            key={s.url}
            type="button"
            onClick={() => load(s.url, s.name, s.kind)}
            className="rounded-full bg-white px-3 py-1.5 text-sm ring-1 ring-stone-300 hover:bg-stone-100"
          >
            {s.name}
          </button>
        ))}
      </div>
      <p className="text-sm text-stone-500">
        <b>Photo frame:</b> design at print size (e.g. 1200×1800 for 4R, 600×1800 for a 2×6 strip at 300 DPI) and leave the
        photo areas <b>transparent</b>. <b>Flipbook page design:</b> 3:2 (e.g. 1800×1200 = 3×2 in at 600 DPI) with exactly{' '}
        <b>one</b> transparent 16:9 hole; keep the left 0.5 in (300 px at 600 DPI) free, as it disappears into the staples.
        Holes are detected automatically.
      </p>

      <ErrorText error={error} />

      {draft && (
        <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)]">
          {/* Phones: as wide as the screen allows (capped at 420px tall); desktop: 420px tall */}
          <div
            className="checker relative mx-auto w-[min(100%,var(--preview-w))] overflow-hidden rounded-lg ring-1 ring-stone-200 md:h-[420px] md:w-auto"
            style={{ aspectRatio: `${draft.width} / ${draft.height}`, '--preview-w': `${(420 * draft.width) / draft.height}px` } as CSSProperties}
          >
            <img src={draft.previewUrl} alt="" className="absolute inset-0 size-full" />
            {draft.slots.map((s, i) => (
              <div
                key={i}
                className="absolute grid place-items-center border-2 border-amber-400 bg-amber-300/30"
                style={{
                  left: `${(s.x / draft.width) * 100}%`,
                  top: `${(s.y / draft.height) * 100}%`,
                  width: `${(s.w / draft.width) * 100}%`,
                  height: `${(s.h / draft.height) * 100}%`,
                }}
              >
                <span className="rounded-full bg-stone-900 px-2 text-xs font-semibold text-white">{i + 1}</span>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-stone-600">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
              />
            </label>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              {(['photo', 'flipbook'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="radio" checked={draft.kind === k} onChange={() => setDraft({ ...draft, kind: k })} />
                  {k === 'photo' ? 'Photo frame' : 'Flipbook page design'}
                </label>
              ))}
            </fieldset>
            <p className="text-sm text-stone-600">
              {draft.width}×{draft.height}px · {draft.slots.length} photo slot{draft.slots.length === 1 ? '' : 's'}
            </p>
            {draft.kind === 'flipbook' && draft.slots.length !== 1 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                A flipbook page design needs exactly one photo area (found {draft.slots.length}).
              </p>
            )}
            {draft.slots.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-stone-500">
                  <tr>
                    <th className="py-1">#</th>
                    {(['x', 'y', 'w', 'h'] as const).map((k) => (
                      <th key={k} className="py-1">
                        {k}
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.slots.map((s, i) => (
                    <tr key={i}>
                      <td className="py-1 pr-2 font-medium">{i + 1}</td>
                      {(['x', 'y', 'w', 'h'] as const).map((k) => (
                        <td key={k} className="py-1 pr-2">
                          <input
                            type="number"
                            value={s[k]}
                            onChange={(e) => updateSlot(i, k, Number(e.target.value))}
                            className="w-full min-w-0 rounded border border-stone-300 px-1.5 py-1 tabular-nums sm:w-20 sm:px-2"
                          />
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          onClick={() => setDraft({ ...draft, slots: draft.slots.filter((_, j) => j !== i) })}
                          className="px-1 py-2 text-xs text-red-700 hover:underline"
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy || draft.slots.length === 0 || (draft.kind === 'flipbook' && draft.slots.length !== 1)}>
                {busy ? 'Saving…' : 'Save frame'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
