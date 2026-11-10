import { useEffect, useState } from 'react'
import { Spinner } from './ui'

/**
 * Plays flipbook pages as an animation (a digital preview of the printed flipbook).
 * Tap to pause/play; drag the slider to flip page by page.
 */
export function FlipbookPlayer({
  frames,
  fps,
  className = '',
  dark = false,
}: {
  frames: string[]
  fps: number
  className?: string
  dark?: boolean
}) {
  const [page, setPage] = useState(0)
  const [playing, setPlaying] = useState(true)
  const framesKey = frames.join('|')
  // Which set of frames has finished preloading (ready = the current set has)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const ready = loadedKey === framesKey

  // Preload every page so playback doesn't stutter while images download.
  useEffect(() => {
    let alive = true
    Promise.all(
      framesKey
        .split('|')
        .filter(Boolean)
        .map((src) => {
          const img = new Image()
          img.src = src
          return img.decode().catch(() => {})
        }),
    ).then(() => alive && setLoadedKey(framesKey))
    return () => {
      alive = false
    }
  }, [framesKey])

  useEffect(() => {
    if (!playing || !ready || frames.length < 2) return
    const id = setInterval(() => setPage((p) => (p + 1) % frames.length), 1000 / fps)
    return () => clearInterval(id)
  }, [playing, ready, fps, frames.length])

  if (frames.length === 0) return null
  const current = page % frames.length
  const muted = dark ? 'text-white/60' : 'text-stone-500'

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        className="relative block w-full overflow-hidden rounded-lg bg-stone-200"
        aria-label={playing ? 'Pause flipbook' : 'Play flipbook'}
      >
        <img src={frames[current]} alt={`Page ${current + 1}`} className="block w-full" draggable={false} />
        {!ready && (
          <span className="absolute inset-0 grid place-items-center bg-white/40">
            <Spinner />
          </span>
        )}
        {ready && !playing && (
          <span className="absolute inset-0 grid place-items-center bg-black/20">
            <span className="rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-stone-900">▶ Play</span>
          </span>
        )}
      </button>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={current}
          onChange={(e) => {
            setPlaying(false)
            setPage(Number(e.target.value))
          }}
          className="flex-1 accent-stone-900"
          aria-label="Flip to page"
        />
        <span className={`text-xs tabular-nums ${muted}`}>
          {current + 1}/{frames.length}
        </span>
      </div>
    </div>
  )
}
