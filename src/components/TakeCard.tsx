import { useEffect, useState } from 'react'
import { adminApi } from '../lib/api'
import { downloadBlob } from '../lib/download'
import { defaultCover, loadDesign, renderCover, renderPage } from '../lib/flipbook'
import type { Paper } from '../lib/flipbookPdf'
import { formatDateTime } from '../lib/format'
import { decode, toBlob } from '../lib/image'
import { prefetch } from '../lib/prefetch'
import type { FlipbookCover, Photo, Take, Template } from '../lib/shared'
import { FlipbookPlayer } from './FlipbookPlayer'
import { Button, ErrorText, Spinner } from './ui'

const PREVIEW_WIDTH = 480
const PREF_PAPER = 'flipbook:paper'

type Busy = { what: 'saving' | 'video' | 'pdf' | 'gif'; done: number; total: number } | null

/** Staff GIF width: sharper than the customer one (made from thumbnails), still a sendable size */
const GIF_WIDTH = 720

function readPaper(): Paper {
  try {
    return localStorage.getItem(PREF_PAPER) === 'letter' ? 'letter' : 'a4'
  } catch {
    return 'a4'
  }
}

const safeName = (s: string) => (s || 'flipbook').replace(/[^\w-]+/g, '-').slice(0, 30)

/**
 * One video take in the admin: design + cover (applied on top, pages stay untouched), animated
 * preview, the customer MP4 (rendered here, stored with the take) and the print PDF.
 */
export function TakeCard({
  take,
  frames,
  designs,
  sessionName,
  onChange,
  onDelete,
}: {
  take: Take
  frames: Photo[]
  designs: Template[]
  sessionName: string
  onChange: (t: Take) => void
  onDelete: () => void
}) {
  const savedCover = take.cover ?? { ...defaultCover(sessionName), enabled: false }
  const [designId, setDesignId] = useState<string | null>(take.design_template_id)
  const [cover, setCover] = useState<FlipbookCover>(savedCover)
  // The saved design/cover can change from outside (the importer sets them right after this card
  // appears). When they do, reset the edit fields to match instead of showing stale "unsaved" edits.
  const savedKey = `${take.design_template_id}|${JSON.stringify(take.cover)}`
  const [syncedKey, setSyncedKey] = useState(savedKey)
  if (savedKey !== syncedKey) {
    setSyncedKey(savedKey)
    setDesignId(take.design_template_id)
    setCover(savedCover)
  }
  const [preview, setPreview] = useState<{ key: string; urls: string[] } | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<unknown>(null)
  const [paper, setPaper] = useState<Paper>(readPaper)

  const design = designs.find((d) => d.id === designId) ?? null
  const dirty = designId !== take.design_template_id || JSON.stringify(cover) !== JSON.stringify(savedCover)
  const ids = frames.map((f) => f.id).join(',')
  const previewKey = `${ids}|${designId}|${JSON.stringify(cover)}`

  // Designed preview from the thumbnails (cheap), redrawn when the design or cover changes.
  useEffect(() => {
    let alive = true
    let created: string[] = []
    const timer = setTimeout(async () => {
      try {
        const d = await loadDesign(design)
        const thumbs = await Promise.all(ids.split(',').filter(Boolean).map((id) => adminApi.photoBlob(id, 'thumb')))
        const pages: Blob[] = []
        for (const [i, blob] of thumbs.entries()) {
          const bmp = await decode(blob)
          if (i === 0 && cover.enabled) pages.push(await toBlob(await renderCover(bmp, d, cover, PREVIEW_WIDTH), 'image/jpeg', 0.8))
          pages.push(await toBlob(renderPage(bmp, d, PREVIEW_WIDTH), 'image/jpeg', 0.8))
          bmp.close()
          if (!alive) return
        }
        created = pages.map((b) => URL.createObjectURL(b))
        if (alive) setPreview({ key: previewKey, urls: created })
        else created.forEach((u) => URL.revokeObjectURL(u))
      } catch (e) {
        if (alive) setError(e)
      }
    }, 150) // let quick typing in the cover fields settle
    return () => {
      alive = false
      clearTimeout(timer)
      created.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [ids, design, cover, previewKey])

  /** Full-size pages for one job (video/PDF/GIF), downloaded a few ahead of where the job is */
  function pageLoader() {
    const blobs = prefetch(frames.map((f) => () => adminApi.photoBlob(f.id, 'full')))
    return async (i: number) => decode(await blobs[i])
  }

  async function makeVideo(current: Take) {
    setBusy({ what: 'video', done: 0, total: frames.length })
    // Loaded on demand: the encoder library is only needed here.
    const { makeFlipbookVideo } = await import('../lib/flipbookVideo')
    const blob = await makeFlipbookVideo({
      count: frames.length,
      getPage: pageLoader(),
      design: await loadDesign(designs.find((d) => d.id === current.design_template_id) ?? null),
      cover: current.cover,
      fps: current.fps,
      onProgress: (done, total) => setBusy({ what: 'video', done, total }),
    })
    onChange(await adminApi.uploadTakeVideo(current.id, blob))
  }

  async function run(task: () => Promise<void>) {
    setError(null)
    try {
      await task()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    run(async () => {
      setBusy({ what: 'saving', done: 0, total: 0 })
      const updated = await adminApi.updateTake(take.id, { design_template_id: designId, cover })
      onChange(updated)
      await makeVideo(updated)
    })

  const downloadVideo = () =>
    run(async () => downloadBlob(await adminApi.takeVideoBlob(take.id), `${safeName(sessionName)}-flipbook.mp4`))

  const printPdf = () =>
    run(async () => {
      setBusy({ what: 'pdf', done: 0, total: frames.length })
      const { makeFlipbookPdf } = await import('../lib/flipbookPdf')
      const pdf = await makeFlipbookPdf({
        count: frames.length,
        getPage: pageLoader(),
        design: await loadDesign(design),
        cover,
        title: sessionName || 'Flipbook',
        paper,
        onProgress: (done, total) => setBusy({ what: 'pdf', done, total }),
      })
      downloadBlob(pdf, `${safeName(sessionName)}-flipbook-print.pdf`)
    })

  const downloadGif = () =>
    run(async () => {
      setBusy({ what: 'gif', done: 0, total: frames.length })
      const { makeFlipbookGif } = await import('../lib/flipbookGif')
      const gif = await makeFlipbookGif({
        count: frames.length,
        getPage: pageLoader(),
        design: await loadDesign(design),
        cover,
        fps: take.fps,
        width: GIF_WIDTH,
        onProgress: (done, total) => setBusy({ what: 'gif', done, total }),
      })
      downloadBlob(gif, `${safeName(sessionName)}-flipbook.gif`)
    })

  function choosePaper(p: Paper) {
    setPaper(p)
    try {
      localStorage.setItem(PREF_PAPER, p)
    } catch {
      /* not remembered */
    }
  }

  const urls = preview?.key === previewKey ? preview.urls : null
  const busyNames = { video: 'Making video', pdf: 'Making print PDF', gif: 'Making GIF' }
  const busyLabel = busy && (busy.what === 'saving' ? 'Saving…' : `${busyNames[busy.what]} ${busy.done}/${busy.total}…`)

  return (
    <div className="space-y-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200">
      {urls ? (
        <FlipbookPlayer frames={urls} fps={take.fps} />
      ) : (
        <div className="grid aspect-video place-items-center rounded-lg bg-stone-200">
          <Spinner />
        </div>
      )}

      <div className="text-sm">
        <p className="font-medium">
          {frames.length} pages · {Math.round(take.fps * 100) / 100} per second
        </p>
        <p className="truncate text-xs text-stone-500">
          {take.source_name || 'video'} · {formatDateTime(take.created_at)}
        </p>
      </div>

      <div className="space-y-2 border-t border-stone-200 pt-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="w-16 text-stone-600">Design</span>
          <select
            value={designId ?? ''}
            onChange={(e) => setDesignId(e.target.value || null)}
            disabled={!!busy}
            className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-2 py-1.5"
          >
            <option value="">Plain pages</option>
            {designs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={cover.enabled}
            onChange={(e) => setCover({ ...cover, enabled: e.target.checked })}
            disabled={!!busy}
          />
          Cover page
        </label>
        {cover.enabled && (
          <div className="grid gap-2">
            <input
              value={cover.title}
              onChange={(e) => setCover({ ...cover, title: e.target.value })}
              placeholder="Title (e.g. names)"
              maxLength={80}
              disabled={!!busy}
              className="rounded-lg border border-stone-300 bg-white px-2 py-1.5"
            />
            <input
              value={cover.subtitle}
              onChange={(e) => setCover({ ...cover, subtitle: e.target.value })}
              placeholder="Subtitle (e.g. date)"
              maxLength={80}
              disabled={!!busy}
              className="rounded-lg border border-stone-300 bg-white px-2 py-1.5"
            />
          </div>
        )}
        {dirty && (
          <Button onClick={save} disabled={!!busy} className="w-full">
            Save design & remake video
          </Button>
        )}
      </div>

      <ErrorText error={error} />

      {busy ? (
        <p className="flex items-center gap-2 text-sm text-stone-600">
          <Spinner className="size-4" /> {busyLabel}
        </p>
      ) : (
        !dirty && (
          <div className="space-y-2 border-t border-stone-200 pt-3">
            <div className="flex gap-2">
              {take.video_key ? (
                <Button variant="secondary" onClick={downloadVideo} className="flex-1">
                  Download video
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => run(() => makeVideo(take))} className="flex-1">
                  Make video
                </Button>
              )}
              <Button variant="secondary" onClick={downloadGif} className="flex-1">
                Download GIF
              </Button>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={printPdf} className="flex-1">
                Print PDF
              </Button>
              <select
                value={paper}
                onChange={(e) => choosePaper(e.target.value as Paper)}
                className="rounded-lg border border-stone-300 bg-white px-2 text-sm"
                aria-label="Paper size"
              >
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
              <Button variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </div>
            <p className="text-xs text-stone-500">
              {take.video_key ? 'Customers see and save this video in their gallery.' : 'No video yet, so the gallery shows a plain preview.'}
            </p>
          </div>
        )
      )}
    </div>
  )
}
