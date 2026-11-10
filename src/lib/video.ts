// Turn a video take into flipbook frames, entirely in the browser.
// The video never leaves this computer; only the chosen frames are uploaded (as JPEGs).
//
// Two ways to read a video:
// - "decoder" (preferred): mediabunny reads the file and decodes frames with WebCodecs. Exact frame rate from the
//   frame timestamps, exact frames, rotation applied, and no <video> element, so iPhone Safari's rule of not
//   loading video data until something plays doesn't apply.
// - "element" (fallback, browsers without WebCodecs or a codec the decoder can't handle): a hidden <video>,
//   frame rate measured by playing ½ s, one seek per frame.
import { THUMB_MAX_EDGE } from './shared'
import { toBlob } from './image'

export class VideoReadError extends Error {}

const READ_HINT =
  "This browser can't read this video. Record in H.264 (MP4/MOV, 8-bit; on iPhone: Settings → Camera → Formats → Most Compatible)."

/** Common camera frame rates; measured rates within 1% snap to these. */
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120]

export interface ExtractedFrame {
  /** Position in the take = flipbook page order */
  index: number
  /** Seconds into the video */
  time: number
  full: Blob
  thumb: Blob
  /** Object URL of the thumb, for previews. Revoke when done. */
  thumbUrl: string
  width: number
  height: number
}

export interface FramePlan {
  times: number[]
  /** Source frames between samples (null when the source fps is unknown → time-based sampling) */
  step: number | null
  /** Actual pages per second of video */
  rate: number
}

export interface ExtractOptions {
  maxEdge: number
  quality?: number
  signal?: AbortSignal
  onFrame: (f: ExtractedFrame) => void
}

/** An opened video take. Times are seconds from the start of the video, as in a <video> player. */
export interface VideoReader {
  engine: 'decoder' | 'element'
  /** Display size (rotation applied) */
  width: number
  height: number
  duration: number
  /** Source frame rate, or null if it couldn't be determined */
  fps: number | null
  /** Grab each moment as a JPEG (+ thumbnail), in order. Calls onFrame as each one is ready. */
  extract(times: number[], opts: ExtractOptions): Promise<void>
  dispose(): void
}

/**
 * Open a video for frame extraction: the WebCodecs decoder when it can handle the file, else a hidden <video>.
 * `url` is an object URL of the same file (used by the fallback). `prefer` forces one engine (for testing).
 */
export async function openVideo(file: Blob, url: string, prefer?: VideoReader['engine']): Promise<VideoReader> {
  if (prefer !== 'element') {
    const reader = await openWithDecoder(file)
    if (reader) return reader
    if (prefer === 'decoder') throw new VideoReadError(READ_HINT)
  }
  return openWithElement(url)
}

function snapFps(fps: number) {
  // Snap to the *closest* standard rate (24 and 23.976 are only 0.1% apart).
  const nearest = STANDARD_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a))
  return Math.abs(nearest - fps) / nearest < 0.01 ? nearest : Math.round(fps * 100) / 100
}

/** Draws a source into a full-size and a thumb canvas and exports both as JPEG. */
function frameEncoder(srcWidth: number, srcHeight: number, maxEdge: number, quality = 0.85) {
  const scale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight))
  const width = Math.round(srcWidth * scale)
  const height = Math.round(srcHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const tScale = Math.min(1, THUMB_MAX_EDGE / Math.max(width, height))
  const thumbCanvas = document.createElement('canvas')
  thumbCanvas.width = Math.round(width * tScale)
  thumbCanvas.height = Math.round(height * tScale)
  const tctx = thumbCanvas.getContext('2d')!
  tctx.imageSmoothingQuality = 'high'

  return {
    width,
    height,
    async encode(src: CanvasImageSource, index: number, time: number): Promise<ExtractedFrame> {
      ctx.drawImage(src, 0, 0, width, height)
      tctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height)
      const [full, thumb] = await Promise.all([toBlob(canvas, 'image/jpeg', quality), toBlob(thumbCanvas, 'image/jpeg', 0.8)])
      return { index, time, full, thumb, thumbUrl: URL.createObjectURL(thumb), width, height }
    },
  }
}

const cancelled = () => new DOMException('Cancelled', 'AbortError')

// ── decoder engine ────────────────────────────────────────────────────────────────────────────

/** null = this browser/file can't use the decoder (the fallback decides whether the file is readable at all). */
async function openWithDecoder(file: Blob): Promise<VideoReader | null> {
  if (typeof VideoDecoder === 'undefined') return null
  // Loaded on demand: only the importer needs it (it's also the MP4 encoder library).
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose()
      return null
    }
    const first = await track.getFirstTimestamp()
    const duration = (await track.computeDuration()) - first
    const { bestGuessFrameRate } = await track.computeFrameRateMetrics()
    const width = track.displayWidth
    const height = track.displayHeight
    return {
      engine: 'decoder',
      width,
      height,
      duration,
      fps: bestGuessFrameRate > 0 ? snapFps(bestGuessFrameRate) : null,
      async extract(times, opts) {
        const enc = frameEncoder(width, height, opts.maxEdge, opts.quality)
        // Decode straight at the output size; CanvasSink applies the rotation from the file.
        const sink = new CanvasSink(track, { width: enc.width, height: enc.height, fit: 'fill', poolSize: 2 })
        let index = 0
        for await (const frame of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
          if (opts.signal?.aborted) throw cancelled()
          if (!frame) throw new VideoReadError(`Frame at ${times[index].toFixed(2)} s could not be read.`)
          opts.onFrame(await enc.encode(frame.canvas, index, times[index]))
          index++
        }
      },
      dispose: () => input.dispose(),
    }
  } catch {
    input.dispose()
    return null
  }
}

// ── element engine (fallback) ─────────────────────────────────────────────────────────────────

function waitFor(el: HTMLMediaElement, event: string, timeoutMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => cleanup(new VideoReadError(`The video didn't load (${event} timed out). ${READ_HINT}`)), timeoutMs)
    const ok = () => cleanup()
    const fail = () => cleanup(new VideoReadError(READ_HINT))
    function cleanup(err?: Error) {
      clearTimeout(timer)
      el.removeEventListener(event, ok)
      el.removeEventListener('error', fail)
      if (err) reject(err)
      else resolve()
    }
    el.addEventListener(event, ok)
    el.addEventListener('error', fail)
  })
}

function seek(v: HTMLVideoElement, t: number) {
  const done = waitFor(v, 'seeked')
  v.currentTime = t
  return done
}

function disposeElement(v: HTMLVideoElement) {
  v.pause()
  v.removeAttribute('src')
  v.load()
  v.remove()
}

/**
 * The element is attached off-screen because some browsers only run frame callbacks for videos that are in
 * the document.
 */
async function openWithElement(src: string): Promise<VideoReader> {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  Object.assign(v.style, { position: 'fixed', left: '-10000px', top: '0', width: '4px', height: '4px' })
  document.body.appendChild(v)
  try {
    const meta = waitFor(v, 'loadedmetadata')
    v.src = src
    await meta
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // iOS ignores preload and loads no picture until playback starts; a muted inline play() is allowed.
      const data = waitFor(v, 'loadeddata')
      v.play().catch(() => {})
      await data
      v.pause()
    }
    if (!v.videoWidth || !v.videoHeight) throw new VideoReadError(READ_HINT)
    // Some files (e.g. browser-recorded WebM) report an Infinity duration until you seek to the end.
    if (!Number.isFinite(v.duration)) {
      const seeked = waitFor(v, 'seeked')
      v.currentTime = 1e9
      await seeked
    }
    await seek(v, 0)
    const fps = await detectFps(v)
    return {
      engine: 'element',
      width: v.videoWidth,
      height: v.videoHeight,
      duration: v.duration,
      fps,
      async extract(times, opts) {
        const enc = frameEncoder(v.videoWidth, v.videoHeight, opts.maxEdge, opts.quality)
        v.pause()
        for (let index = 0; index < times.length; index++) {
          if (opts.signal?.aborted) throw cancelled()
          await seek(v, times[index])
          opts.onFrame(await enc.encode(v, index, times[index]))
        }
      },
      dispose: () => disposeElement(v),
    }
  } catch (e) {
    disposeElement(v)
    throw e
  }
}

/**
 * Measure the source frame rate from real frame timestamps (requestVideoFrameCallback),
 * by playing ~half a second muted. Returns null if the browser can't tell us.
 */
async function detectFps(v: HTMLVideoElement): Promise<number | null> {
  if (!('requestVideoFrameCallback' in v)) return null
  const stamps: number[] = []
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      v.pause()
      resolve()
    }
    const timer = setTimeout(finish, 2500)
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      stamps.push(meta.mediaTime)
      if (stamps.length >= 16) finish()
      else v.requestVideoFrameCallback(onFrame)
    }
    v.requestVideoFrameCallback(onFrame)
    v.play().catch(finish)
  })
  await seek(v, 0)

  // Smallest gap between presented frames = one frame (dropped frames only make gaps bigger).
  const gaps = stamps
    .slice(1)
    .map((t, i) => t - stamps[i])
    .filter((g) => g > 0.001)
  if (gaps.length < 3) return null
  return snapFps(1 / Math.min(...gaps))
}

/**
 * Which moments to grab. With a known source fps we step over whole frames (every Nth frame)
 * and aim at the middle of each frame, so the motion is perfectly even and the seek can't land
 * on a neighbour. Without it, we sample by time at the target rate.
 */
export function planFrames(opts: { sourceFps: number | null; targetFps: number; start: number; end: number }): FramePlan {
  const { sourceFps, targetFps, start, end } = opts
  if (end <= start) return { times: [], step: null, rate: targetFps }
  if (sourceFps) {
    // Whole-frame step whose resulting rate is closest to the target (30 fps → every 3rd = 10/s, not 15/s).
    const lo = Math.max(1, Math.floor(sourceFps / targetFps))
    const step = Math.abs(sourceFps / lo - targetFps) <= Math.abs(sourceFps / (lo + 1) - targetFps) ? lo : lo + 1
    const first = Math.ceil(start * sourceFps - 1e-6)
    const times: number[] = []
    for (let f = first; (f + 0.5) / sourceFps < end; f += step) times.push((f + 0.5) / sourceFps)
    return { times, step, rate: sourceFps / step }
  }
  const count = Math.floor((end - start) * targetFps + 1e-6)
  return {
    times: Array.from({ length: count }, (_, k) => start + k / targetFps + 0.001),
    step: null,
    rate: targetFps,
  }
}
