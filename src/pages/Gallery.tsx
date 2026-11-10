import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { FlipbookPlayer } from '../components/FlipbookPlayer'
import { Spinner } from '../components/ui'
import { ApiError, publicApi } from '../lib/publicApi'
import { downloadBlob } from '../lib/download'
import { daysLeft, formatDate } from '../lib/format'
import type { PublicSession } from '../lib/shared'
import { pageFileName, zipFiles } from '../lib/zip'

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
            Your flipbook{takes.length > 1 ? 's' : ''} · tap to pause, slide to flip
          </h2>
          <div className={`mx-auto grid max-w-3xl gap-6 ${takes.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {takes.map((t) => (
              <GalleryTake key={t.id} pages={t.pages} fps={t.fps} name={data.name} single={takes.length === 1} />
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

function GalleryTake({
  pages,
  fps,
  name,
  single,
}: {
  pages: GalleryPhoto[]
  fps: number
  name: string
  single: boolean
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')

  async function download() {
    setState('busy')
    try {
      const blobs = await Promise.all(
        pages.map(async (p) => {
          const res = await fetch(publicApi.photoUrl(p.id, 'full'))
          if (!res.ok) throw new Error('Download failed')
          return res.blob()
        }),
      )
      const zip = await zipFiles(blobs.map((blob, i) => ({ name: pageFileName(i), blob })))
      downloadBlob(zip, `${(name || 'flipbook').replace(/[^\w-]+/g, '-').slice(0, 30)}-flipbook.zip`)
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <div className={single ? 'mx-auto w-full max-w-lg' : ''}>
      <FlipbookPlayer
        frames={pages.map((p) => publicApi.photoUrl(p.id, 'thumb'))}
        fps={fps}
        className="[&_button]:shadow-lg [&_button]:ring-1 [&_button]:ring-black/5"
      />
      <div className="mt-2 flex items-center justify-between gap-3 text-sm">
        <span className="text-stone-500">{pages.length} pages</span>
        <button
          type="button"
          onClick={download}
          disabled={state === 'busy'}
          className="rounded-full bg-white px-4 py-2 font-medium shadow ring-1 ring-black/5 disabled:opacity-60"
        >
          {state === 'busy' ? 'Preparing…' : state === 'error' ? 'Failed. Try again' : 'Download pages (.zip)'}
        </button>
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
