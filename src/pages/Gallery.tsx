import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { FlipbookPlayer } from '../components/FlipbookPlayer'
import { Spinner } from '../components/ui'
import { ApiError, publicApi } from '../lib/publicApi'
import { downloadBlob } from '../lib/download'
import { daysLeft, formatDate } from '../lib/format'
import type { PublicSession, PublicTake } from '../lib/shared'
import { zipFiles } from '../lib/zip'

type GalleryPhoto = Extract<PublicSession, { status: 'ok' }>['photos'][number]

/** Can this device hand files to the native share sheet ("Save to Photos" on phones)? */
const canShareFiles = (() => {
  try {
    return !!navigator.canShare?.({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] })
  } catch {
    return false
  }
})()

export function Gallery() {
  const { slug } = useParams() as { slug: string }
  const [data, setData] = useState<PublicSession | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    publicApi.session(slug).then(setData, setError)
  }, [slug])

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <Shell>
        <Message title={notFound ? 'Link not found' : 'Something went wrong'}>
          {notFound ? 'Check the link or scan the QR code on your print again.' : error.message}
        </Message>
      </Shell>
    )
  }
  if (!data) {
    return (
      <Shell>
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      </Shell>
    )
  }
  if (data.status === 'expired') {
    return (
      <Shell>
        <Message title="This gallery has expired">
          Photos were available until {formatDate(data.expires_at)}. Contact the studio if you'd like to extend access.
        </Message>
      </Shell>
    )
  }

  const framed = data.photos.filter((p) => p.kind === 'framed')
  const raw = data.photos.filter((p) => p.kind === 'raw')
  const ordered = [...framed, ...raw] // lightbox + "save all" order (flipbook pages are separate)
  const takes = data.takes
    .map((t) => ({
      ...t,
      pages: data.photos
        .filter((p) => p.kind === 'frame' && p.take_id === t.id)
        .sort((a, b) => (a.frame_index ?? 0) - (b.frame_index ?? 0)),
    }))
    .filter((t) => t.pages.length > 0)
  const left = daysLeft(data.expires_at)

  return (
    <Shell>
      <header className="px-4 pt-10 pb-6 text-center">
        <p className="text-xs tracking-[0.3em] text-stone-500 uppercase">Your photos</p>
        <h1 className="font-display mt-2 text-4xl">{data.name || 'Flipbook session'}</h1>
        <p className="mt-2 text-sm text-stone-500">
          Available until {formatDate(data.expires_at)} ({left} day{left === 1 ? '' : 's'} left). Save them before then.
        </p>
        {ordered.length > 0 && <SaveAll photos={ordered} name={data.name} />}
      </header>

      {data.photos.length === 0 && (
        <Message title="Photos are on their way">The studio is still uploading. Check back in a few minutes.</Message>
      )}

      {takes.length > 0 && (
        <section className="px-4 pb-10">
          <h2 className="mx-auto mb-3 max-w-3xl text-sm font-medium text-stone-500">
            Your flipbook{takes.length > 1 ? 's' : ''}
          </h2>
          <div className={`mx-auto grid max-w-3xl gap-6 ${takes.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {takes.map((t) => (
              <GalleryTake key={t.id} take={t} pages={t.pages} name={data.name} single={takes.length === 1} />
            ))}
          </div>
        </section>
      )}

      {framed.length > 0 && (
        <section className="px-4 pb-8">
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-4">
            {framed.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setOpen(ordered.indexOf(p))}
                className={framed.length === 1 ? 'col-span-2 mx-auto max-w-sm' : ''}
              >
                {/* Framed photos are the hero (and few), so show full size: thumbs look soft on phones */}
                <img
                  src={publicApi.photoUrl(p.id, 'full')}
                  alt="Framed photo"
                  loading="lazy"
                  className="w-full rounded-md shadow-lg ring-1 ring-black/5"
                  style={{ aspectRatio: `${p.width} / ${p.height}` }}
                />
              </button>
            ))}
          </div>
        </section>
      )}

      {raw.length > 0 && (
        <section className="px-4 pb-16">
          <h2 className="mx-auto mb-3 max-w-3xl text-sm font-medium text-stone-500">All shots · {raw.length}</h2>
          <div className="mx-auto grid max-w-3xl grid-cols-3 gap-1.5 sm:grid-cols-4">
            {raw.map((p) => (
              <button key={p.id} type="button" onClick={() => setOpen(ordered.indexOf(p))}>
                <img
                  src={publicApi.photoUrl(p.id, 'thumb')}
                  alt="Photo"
                  loading="lazy"
                  className="aspect-square w-full rounded object-cover"
                />
              </button>
            ))}
          </div>
        </section>
      )}

      {open !== null && <Lightbox photos={ordered} index={open} onChange={setOpen} />}
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-[#f7f3ee]">{children}</div>
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="font-display text-3xl">{title}</h1>
      <p className="mt-3 text-stone-600">{children}</p>
    </div>
  )
}

/** Customer GIF width: built from the 480 px thumbnails, so a designed page (photo ≈ 78% of it) at 600 px is sharp enough */
const GIF_WIDTH = { designed: 600, plain: 480 }

type SaveKind = 'video' | 'gif'
type SaveState =
  | { step: 'idle' }
  | { step: 'busy'; kind: SaveKind; done?: number; total?: number }
  | { step: 'ready'; kind: SaveKind; file: File }
  | { step: 'error'; kind: SaveKind }

function GalleryTake({
  take,
  pages,
  name,
  single,
}: {
  take: PublicTake
  pages: GalleryPhoto[]
  name: string
  single: boolean
}) {
  const [state, setState] = useState<SaveState>({ step: 'idle' })
  const base = `${(name || 'flipbook').replace(/[^\w-]+/g, '-').slice(0, 30)}-flipbook`

  // Phones: prepare the file, then a second tap opens the share sheet (share needs a fresh tap).
  // Computers: a normal download.
  async function saveVideo() {
    if (!canShareFiles) {
      window.location.href = publicApi.takeVideoUrl(take.id, true)
      return
    }
    setState({ step: 'busy', kind: 'video' })
    try {
      const res = await fetch(publicApi.takeVideoUrl(take.id))
      if (!res.ok) throw new Error()
      setState({ step: 'ready', kind: 'video', file: new File([await res.blob()], `${base}.mp4`, { type: 'video/mp4' }) })
    } catch {
      setState({ step: 'error', kind: 'video' })
    }
  }

  // Built on this phone from the page thumbnails, with the same design + cover as the video.
  async function saveGif() {
    setState({ step: 'busy', kind: 'gif', done: 0, total: pages.length })
    try {
      const [{ makeFlipbookGif }, { loadDesign }, { decode }, { prefetch }] = await Promise.all([
        import('../lib/flipbookGif'),
        import('../lib/flipbook'),
        import('../lib/image'),
        import('../lib/prefetch'),
      ])
      const thumbs = prefetch(
        pages.map((p) => async () => {
          const res = await fetch(publicApi.photoUrl(p.id, 'thumb'))
          if (!res.ok) throw new Error(`Page download failed (${res.status})`)
          return res.blob()
        }),
      )
      const blob = await makeFlipbookGif({
        count: pages.length,
        getPage: async (i) => decode(await thumbs[i]),
        design: await loadDesign(take.design),
        cover: take.cover,
        fps: take.fps,
        width: take.design ? GIF_WIDTH.designed : GIF_WIDTH.plain,
        onProgress: (done, total) => setState({ step: 'busy', kind: 'gif', done, total }),
      })
      const file = new File([blob], `${base}.gif`, { type: 'image/gif' })
      if (canShareFiles) setState({ step: 'ready', kind: 'gif', file })
      else {
        downloadBlob(file, file.name)
        setState({ step: 'idle' })
      }
    } catch {
      setState({ step: 'error', kind: 'gif' })
    }
  }

  async function share(file: File) {
    try {
      await navigator.share({ files: [file] })
    } catch {
      /* cancelled */
    }
    setState({ step: 'idle' })
  }

  const btn = 'rounded-full bg-white px-4 py-2 font-medium shadow ring-1 ring-black/5 disabled:opacity-60'
  const label = (kind: SaveKind, text: string) => {
    if (state.step === 'busy' && state.kind === kind) {
      return state.total ? `Making GIF ${state.done}/${state.total}…` : 'Preparing…'
    }
    if (state.step === 'error' && state.kind === kind) return 'Failed. Try again'
    return text
  }

  return (
    <div className={single ? 'mx-auto w-full max-w-lg' : ''}>
      {take.has_video ? (
        <video
          src={publicApi.takeVideoUrl(take.id)}
          autoPlay
          loop
          muted
          playsInline
          className="block w-full rounded-lg bg-stone-200 shadow-lg ring-1 ring-black/5"
        />
      ) : (
        // Video not made yet: plain animated preview of the pages
        <FlipbookPlayer frames={pages.map((p) => publicApi.photoUrl(p.id, 'thumb'))} fps={take.fps} />
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-stone-500">{pages.length} pages</span>
        {state.step === 'ready' ? (
          <button type="button" onClick={() => share(state.file)} className={`${btn} bg-emerald-700 text-white`}>
            Tap to save {state.kind === 'video' ? 'video' : 'GIF'}
          </button>
        ) : (
          <div className="flex gap-2">
            {take.has_video && (
              <button type="button" onClick={saveVideo} disabled={state.step === 'busy'} className={btn}>
                {label('video', 'Save video')}
              </button>
            )}
            <button type="button" onClick={saveGif} disabled={state.step === 'busy'} className={btn}>
              {label('gif', 'Save GIF')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SaveAll({ photos, name }: { photos: GalleryPhoto[]; name: string }) {
  const [state, setState] = useState<
    { step: 'idle' } | { step: 'loading'; done: number } | { step: 'ready'; files: File[] } | { step: 'error'; msg: string }
  >({ step: 'idle' })
  const base = (name || 'flipbook').replace(/[^\w-]+/g, '-').slice(0, 30)

  async function fetchAll() {
    setState({ step: 'loading', done: 0 })
    try {
      let done = 0
      const files = await Promise.all(
        photos.map(async (p, i) => {
          const res = await fetch(publicApi.photoUrl(p.id, 'full'))
          if (!res.ok) throw new Error('Download failed')
          const blob = await res.blob()
          setState({ step: 'loading', done: ++done })
          return new File([blob], `${base}-${p.kind}-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' })
        }),
      )
      if (canShareFiles) {
        // Share needs a fresh tap, so ask for one more click.
        setState({ step: 'ready', files })
      } else {
        downloadBlob(await zipFiles(files.map((f) => ({ name: f.name, blob: f }))), `${base}.zip`)
        setState({ step: 'idle' })
      }
    } catch (e) {
      setState({ step: 'error', msg: e instanceof Error ? e.message : 'Download failed' })
    }
  }

  async function share(files: File[]) {
    try {
      await navigator.share({ files })
    } catch {
      /* user cancelled */
    }
    setState({ step: 'idle' })
  }

  const btn = 'mt-5 inline-flex items-center gap-2 rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white shadow-lg active:scale-[0.98]'

  if (state.step === 'loading') {
    return (
      <button type="button" disabled className={btn}>
        <Spinner className="size-4" /> Preparing {state.done}/{photos.length}…
      </button>
    )
  }
  if (state.step === 'ready') {
    return (
      <button type="button" onClick={() => share(state.files)} className={`${btn} bg-emerald-700`}>
        Tap to save {state.files.length} photos
      </button>
    )
  }
  return (
    <div>
      <button type="button" onClick={fetchAll} className={btn}>
        {canShareFiles ? 'Save all to phone' : 'Download all (.zip)'}
      </button>
      {state.step === 'error' && <p className="mt-2 text-sm text-red-700">{state.msg}</p>}
    </div>
  )
}

function Lightbox({
  photos,
  index,
  onChange,
}: {
  photos: GalleryPhoto[]
  index: number
  onChange: (i: number | null) => void
}) {
  const photo = photos[index]
  const prev = () => onChange((index - 1 + photos.length) % photos.length)
  const next = () => onChange((index + 1) % photos.length)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onChange(null)
      if (e.key === 'ArrowLeft') onChange((index - 1 + photos.length) % photos.length)
      if (e.key === 'ArrowRight') onChange((index + 1) % photos.length)
    }
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [index, photos.length, onChange])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white" role="dialog" aria-label="Photo viewer">
      <div className="flex items-center justify-between p-3 text-sm">
        <span className="tabular-nums opacity-70">
          {index + 1} / {photos.length}
        </span>
        <button type="button" onClick={() => onChange(null)} className="rounded-full px-3 py-1.5 hover:bg-white/10">
          Close
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        <img
          key={photo.id}
          src={publicApi.photoUrl(photo.id, 'full')}
          alt=""
          className="max-h-full max-w-full object-contain"
        />
        {photos.length > 1 && (
          <>
            <button type="button" onClick={prev} aria-label="Previous" className="absolute inset-y-0 left-0 w-1/4" />
            <button type="button" onClick={next} aria-label="Next" className="absolute inset-y-0 right-0 w-1/4" />
          </>
        )}
      </div>
      <div className="flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <a
          href={publicApi.photoUrl(photo.id, 'full', true)}
          className="rounded-full bg-white px-6 py-3 text-sm font-medium text-stone-900"
        >
          Download
        </a>
      </div>
    </div>
  )
}
