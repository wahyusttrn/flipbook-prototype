// Turn a video take into flipbook frames, entirely in the browser.
// The video never leaves this computer; only the chosen frames are uploaded (as JPEGs).
import { THUMB_MAX_EDGE } from './shared'
import { toBlob } from './image'

export class VideoReadError extends Error {}

const READ_HINT =
  "This browser can't read this video. Record in H.264 (MP4/MOV, 8-bit). Some 10-bit or HEVC camera modes don't play in browsers."

/** Common camera frame rates; detected rates within 1% snap to these. */
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

function waitFor(el: HTMLMediaElement, event: string, timeoutMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => cleanup(new Error(`Video ${event} timed out`)), timeoutMs)
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

/**
 * Load a video for frame extraction. The element is attached off-screen because some
 * browsers only run frame callbacks for videos that are in the document.
 */
export async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  Object.assign(v.style, { position: 'fixed', left: '-10000px', top: '0', width: '4px', height: '4px' })
  document.body.appendChild(v)
  try {
    const loaded = waitFor(v, 'loadeddata')
    v.src = src
    await loaded
    if (!v.videoWidth || !v.videoHeight) throw new VideoReadError(READ_HINT)
    // Some files (e.g. browser-recorded WebM) report an Infinity duration until you seek to the end.
    if (!Number.isFinite(v.duration)) {
      const seeked = waitFor(v, 'seeked')
      v.currentTime = 1e9
      await seeked
      await seek(v, 0)
    }
    return v
  } catch (e) {
    disposeVideo(v)
    throw e
  }
}

export function disposeVideo(v: HTMLVideoElement) {
  v.pause()
  v.removeAttribute('src')
  v.load()
  v.remove()
}

function seek(v: HTMLVideoElement, t: number) {
  const done = waitFor(v, 'seeked')
  v.currentTime = t
  return done
}

/**
 * Measure the source frame rate from real frame timestamps (requestVideoFrameCallback),
 * by playing ~half a second muted. Returns null if the browser can't tell us.
 */
export async function detectFps(v: HTMLVideoElement): Promise<number | null> {
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
  const fps = 1 / Math.min(...gaps)
  // Snap to the *closest* standard rate (24 and 23.976 are only 0.1% apart).
  const nearest = STANDARD_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a))
  return Math.abs(nearest - fps) / nearest < 0.01 ? nearest : Math.round(fps * 100) / 100
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

/** Grab each planned moment as a JPEG (+ thumbnail). Calls onFrame as each one is ready. */
export async function extractFrames(
  v: HTMLVideoElement,
  times: number[],
  opts: { maxEdge: number; quality?: number; signal?: AbortSignal; onFrame: (f: ExtractedFrame) => void },
) {
  const scale = Math.min(1, opts.maxEdge / Math.max(v.videoWidth, v.videoHeight))
  const width = Math.round(v.videoWidth * scale)
  const height = Math.round(v.videoHeight * scale)
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

  v.pause()
  for (let index = 0; index < times.length; index++) {
    if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    await seek(v, times[index])
    ctx.drawImage(v, 0, 0, width, height)
    tctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height)
    const [full, thumb] = await Promise.all([
      toBlob(canvas, 'image/jpeg', opts.quality ?? 0.85),
      toBlob(thumbCanvas, 'image/jpeg', 0.8),
    ])
    opts.onFrame({ index, time: times[index], full, thumb, thumbUrl: URL.createObjectURL(thumb), width, height })
  }
}
