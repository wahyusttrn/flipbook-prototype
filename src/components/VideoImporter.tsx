import { useEffect, useRef, useState } from 'react'
import { adminApi } from '../lib/api'
import { DEFAULT_FLIPBOOK_FPS, FRAME_MAX_EDGE, MAX_TAKE_FRAMES, type Photo, type Take } from '../lib/shared'
import { detectFps, disposeVideo, extractFrames, loadVideo, planFrames, type ExtractedFrame } from '../lib/video'
import { FlipbookPlayer } from './FlipbookPlayer'
import { Button, ErrorText, Spinner } from './ui'

type Mode = 'auto' | 'pick'
type Phase = 'loading' | 'ready' | 'extracting' | 'review' | 'uploading'

const RATE_OPTIONS = [8, 10, 12, 15, 24]
const UPLOAD_CONCURRENCY = 4
const PREF_RATE = 'flipbook:rate'
const PREF_MODE = 'flipbook:mode'

function readPref(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode: just don't remember */
  }
}

const ordinal = (n: number) => (n === 1 ? 'every frame' : `every ${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'} frame`)
const secs = (n: number) => `${n.toFixed(1)} s`

/**
 * Video take → flipbook pages, on this computer. Only the chosen frames are uploaded;
 * the video file itself never leaves the browser.
 */
export function VideoImporter({
  file,
  sessionId,
  onDone,
  onClose,
}: {
  file: File
  sessionId: string
  onDone: (take: Take, frames: Photo[]) => void
  onClose: () => void
}) {
  /** Object URL of the file, for the visible preview (set once the video has loaded) */
  const [url, setUrl] = useState<string | null>(null)
  const preview = useRef<HTMLVideoElement>(null)
  const worker = useRef<HTMLVideoElement | null>(null)
  const abort = useRef<AbortController | null>(null)

  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<unknown>(null)
  const [duration, setDuration] = useState(0)
  const [sourceFps, setSourceFps] = useState<number | null>(null)
  const [targetFps, setTargetFps] = useState(() => Number(readPref(PREF_RATE)) || DEFAULT_FLIPBOOK_FPS)
  const [mode, setMode] = useState<Mode>(() => (readPref(PREF_MODE) === 'pick' ? 'pick' : 'auto'))
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [frames, setFrames] = useState<ExtractedFrame[]>([])
  const [selected, setSelected] = useState<boolean[]>([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [failed, setFailed] = useState<string[]>([])

  // Load the video off-screen and measure its frame rate. The object URL is created and
  // revoked by this same effect, so React's dev double-mount can't leave a revoked URL behind.
  useEffect(() => {
    let alive = true
    let v: HTMLVideoElement | null = null
    const objectUrl = URL.createObjectURL(file)
    ;(async () => {
      v = await loadVideo(objectUrl)
      const fps = await detectFps(v)
      if (!alive) return disposeVideo(v)
      worker.current = v
      setUrl(objectUrl)
      setDuration(v.duration)
      setEnd(v.duration)
      setSourceFps(fps)
      setPhase('ready')
    })().catch((e) => alive && setError(e))
    return () => {
      alive = false
      abort.current?.abort()
      if (v) disposeVideo(v)
      worker.current = null
      URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  // Free frame thumbnails when the importer goes away.
  const framesRef = useRef<ExtractedFrame[]>([])
  useEffect(() => {
    framesRef.current = frames
  }, [frames])
  useEffect(() => () => framesRef.current.forEach((f) => URL.revokeObjectURL(f.thumbUrl)), [])

  const plan = planFrames({ sourceFps, targetFps, start, end })
  const pageCount = plan.times.length
  const tooMany = pageCount > MAX_TAKE_FRAMES

  function chooseRate(n: number) {
    setTargetFps(n)
    writePref(PREF_RATE, String(n))
  }
  function chooseMode(m: Mode) {
    setMode(m)
    writePref(PREF_MODE, m)
  }

  async function extract() {
    const v = worker.current
    if (!v || pageCount === 0 || tooMany) return
    setError(null)
    frames.forEach((f) => URL.revokeObjectURL(f.thumbUrl))
    setFrames([])
    setPhase('extracting')
    setProgress({ done: 0, total: pageCount })
    abort.current = new AbortController()
    const got: ExtractedFrame[] = []
    try {
      await extractFrames(v, plan.times, {
        maxEdge: FRAME_MAX_EDGE,
        signal: abort.current.signal,
        onFrame: (f) => {
          got.push(f)
          setProgress({ done: got.length, total: pageCount })
        },
      })
    } catch (e) {
      got.forEach((f) => URL.revokeObjectURL(f.thumbUrl))
      if ((e as Error).name !== 'AbortError') setError(e)
      setPhase('ready')
      return
    }
    setFrames(got)
    setSelected(got.map(() => true))
    if (mode === 'auto') await upload(got)
    else setPhase('review')
  }

  async function upload(list: ExtractedFrame[]) {
    if (!list.length) return
    setPhase('uploading')
    setFailed([])
    setProgress({ done: 0, total: list.length })
    try {
      const take = await adminApi.createTake(sessionId, Math.round(plan.rate * 1000) / 1000, file.name)
      const uploaded: Photo[] = []
      const errors: string[] = []
      let next = 0
      let done = 0
      const runner = async () => {
        while (next < list.length) {
          const order = next++
          const f = list[order]
          try {
            uploaded.push(
              await adminApi.uploadPhoto({
                sessionId,
                kind: 'frame',
                full: f.full,
                thumb: f.thumb,
                width: f.width,
                height: f.height,
                takeId: take.id,
                frameIndex: order,
              }),
            )
          } catch (e) {
            errors.push(`Page ${order + 1}: ${e instanceof Error ? e.message : 'failed'}`)
          }
          setProgress({ done: ++done, total: list.length })
        }
      }
      await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, runner))
      uploaded.sort((a, b) => (a.frame_index ?? 0) - (b.frame_index ?? 0))
      onDone(take, uploaded)
      if (errors.length) {
        setFailed(errors)
        setPhase('review')
      } else {
        onClose()
      }
    } catch (e) {
      setError(e)
      setPhase(mode === 'pick' ? 'review' : 'ready')
    }
  }

  function setFromPreview(which: 'start' | 'end') {
    const t = preview.current?.currentTime ?? 0
    if (which === 'start') setStart(Math.min(t, end))
    else setEnd(Math.max(t, start))
  }

  const busy = phase === 'extracting' || phase === 'uploading' || phase === 'loading'
  const chosen = frames.filter((_, i) => selected[i])

  return (
    <div className="space-y-4 rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Video → flipbook pages</p>
          <p className="truncate text-sm text-stone-500">
            {file.name}. Frames are picked on this computer; the video itself isn't uploaded.
          </p>
        </div>
        {phase === 'extracting' ? (
          <Button variant="ghost" onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose} disabled={phase === 'uploading'}>
            Close
          </Button>
        )}
      </div>

      <ErrorText error={error} />

      {!error || phase !== 'loading' ? (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {url ? (
            <video ref={preview} src={url} controls muted playsInline className="max-h-80 w-full rounded-lg bg-black" />
          ) : (
            <div className="grid aspect-video w-full place-items-center rounded-lg bg-stone-200">
              <Spinner />
            </div>
          )}

          <div className="space-y-4 text-sm">
            {phase === 'loading' ? (
              <p className="flex items-center gap-2 text-stone-500">
                <Spinner className="size-4" /> Reading video…
              </p>
            ) : (
              <>
                <p className="text-stone-600">
                  {sourceFps ? `${sourceFps} fps` : 'Unknown frame rate (sampling by time)'} · {secs(duration)}
                </p>

                <label className="flex items-center gap-3">
                  <span className="w-28 text-stone-600">Pages per second</span>
                  <select
                    value={targetFps}
                    onChange={(e) => chooseRate(Number(e.target.value))}
                    disabled={busy}
                    className="rounded-lg border border-stone-300 bg-white px-2 py-1.5"
                  >
                    {RATE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                        {r === DEFAULT_FLIPBOOK_FPS ? ' (recommended)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="space-y-2">
                  <TrimRow label="Start" value={start} min={0} max={end} disabled={busy} onChange={setStart} onUseCurrent={() => setFromPreview('start')} />
                  <TrimRow label="End" value={end} min={start} max={duration} disabled={busy} onChange={setEnd} onUseCurrent={() => setFromPreview('end')} />
                </div>

                <p className={`rounded-lg px-3 py-2 ${tooMany || pageCount === 0 ? 'bg-amber-50 text-amber-900' : 'bg-white ring-1 ring-stone-200'}`}>
                  {plan.step ? `${ordinal(plan.step)} → ` : ''}
                  {Math.round(plan.rate * 100) / 100} pages/s → <b>{pageCount} pages</b>
                  {tooMany && ` · max ${MAX_TAKE_FRAMES}, so trim the video`}
                  {pageCount === 0 && ' · nothing selected, so check start/end'}
                </p>

                <fieldset className="space-y-1.5">
                  <legend className="mb-1 text-stone-600">After extracting</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={mode === 'auto'} onChange={() => chooseMode('auto')} disabled={busy} />
                    Upload all pages automatically
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={mode === 'pick'} onChange={() => chooseMode('pick')} disabled={busy} />
                    Let me review and pick pages first
                  </label>
                </fieldset>

                {(phase === 'ready' || phase === 'review') && (
                  <Button onClick={extract} disabled={pageCount === 0 || tooMany}>
                    {phase === 'review' ? 'Extract again' : mode === 'auto' ? `Extract & upload ${pageCount} pages` : `Extract ${pageCount} pages`}
                  </Button>
                )}

                {(phase === 'extracting' || phase === 'uploading') && (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-2 text-stone-600">
                      <Spinner className="size-4" />
                      {phase === 'extracting' ? 'Extracting' : 'Uploading'} {progress.done}/{progress.total}…
                    </p>
                    <div className="h-1.5 overflow-hidden rounded-full bg-stone-200">
                      <div
                        className="h-full bg-stone-900 transition-all"
                        style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}

      {failed.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <li className="font-medium">Some pages failed to upload. The take was saved without them.</li>
          {failed.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {phase === 'review' && frames.length > 0 && failed.length === 0 && (
        <div className="space-y-3 border-t border-stone-200 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm text-stone-600">
              <b>{chosen.length}</b> of {frames.length} pages selected. Tap a page to leave it out.
            </p>
            <Button variant="ghost" onClick={() => setSelected(frames.map(() => true))}>
              Select all
            </Button>
            <Button variant="ghost" onClick={() => setSelected(frames.map(() => false))}>
              Select none
            </Button>
            <Button onClick={() => upload(chosen)} disabled={chosen.length === 0}>
              Upload {chosen.length} pages
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <FlipbookPlayer frames={chosen.map((f) => f.thumbUrl)} fps={plan.rate} className="w-full max-w-60" />
            <div className="grid max-h-[420px] grid-cols-4 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-6 xl:grid-cols-8">
              {frames.map((f, i) => (
                <button
                  key={f.index}
                  type="button"
                  onClick={() => setSelected((s) => s.map((v, j) => (j === i ? !v : v)))}
                  className={`relative overflow-hidden rounded ring-2 ${selected[i] ? 'ring-stone-900' : 'opacity-35 ring-transparent'}`}
                  title={`Page ${i + 1} · ${f.time.toFixed(2)} s`}
                >
                  <img src={f.thumbUrl} alt="" className="block w-full" draggable={false} />
                  <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white tabular-nums">
                    {i + 1}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TrimRow({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
  onUseCurrent,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (v: number) => void
  onUseCurrent: () => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 text-stone-600">{label}</span>
      <input
        type="number"
        step={0.1}
        min={min}
        max={max}
        value={Math.round(value * 10) / 10}
        disabled={disabled}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))}
        className="w-20 rounded-lg border border-stone-300 bg-white px-2 py-1.5 tabular-nums"
      />
      <span className="text-stone-500">s</span>
      <button type="button" onClick={onUseCurrent} disabled={disabled} className="text-xs text-stone-600 underline disabled:opacity-40">
        use video position
      </button>
    </div>
  )
}
