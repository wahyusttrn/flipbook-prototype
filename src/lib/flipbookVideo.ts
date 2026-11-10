// Flipbook → MP4, made on the studio PC with the browser's video encoder (WebCodecs, via mediabunny).
// Stored with the take so customers just download a ready file.
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_LOW, QUALITY_MEDIUM, canEncodeVideo, type Quality } from 'mediabunny'
import { renderCover, renderPage, type PageDesign } from './flipbook'
import { sizeOf } from './image'
import { COVER_SECONDS, END_HOLD_SECONDS, MAX_UPLOAD_BYTES, type FlipbookCover } from './shared'

/** Long edge of the video. Plenty for phones and keeps a 6 s take around 1–3 MB. */
const VIDEO_MAX_EDGE = 1280

export interface FlipbookVideoInput {
  count: number
  /** Full-size page i (the caller closes nothing; we close each bitmap after drawing) */
  getPage: (i: number) => Promise<ImageBitmap>
  design: PageDesign | null
  cover: FlipbookCover | null
  fps: number
  onProgress?: (done: number, total: number) => void
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export async function makeFlipbookVideo(input: FlipbookVideoInput): Promise<Blob> {
  const first = await input.getPage(0)
  const natural = input.design ? { w: input.design.template.width, h: input.design.template.height } : sizeOf(first)
  first.close()
  const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(natural.w, natural.h))
  const width = even(natural.w * scale)
  const height = even(natural.h * scale)

  if (typeof VideoEncoder === 'undefined' || !(await canEncodeVideo('avc', { width, height }))) {
    throw new Error("This browser can't make MP4 videos. Use Chrome or Edge on the studio PC.")
  }

  // Medium quality first; if it's over the upload limit, redo it at low quality.
  let blob = await encode(input, width, height, QUALITY_MEDIUM)
  if (blob.size > MAX_UPLOAD_BYTES) blob = await encode(input, width, height, QUALITY_LOW)
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('The video is too large to upload. Trim the take.')
  return blob
}

async function encode(input: FlipbookVideoInput, width: number, height: number, quality: Quality): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const source = new CanvasSource(canvas, { codec: 'avc', quality, keyFrameInterval: 1 })
  output.addVideoTrack(source, { frameRate: input.fps })
  await output.start()

  const total = input.count + (input.cover?.enabled ? 1 : 0)
  let done = 0
  let t = 0
  const draw = (page: HTMLCanvasElement) => {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(page, 0, 0, width, height)
  }
  try {
    if (input.cover?.enabled) {
      const bmp = await input.getPage(0)
      draw(await renderCover(bmp, input.design, input.cover, width))
      bmp.close()
      await source.add(t, COVER_SECONDS)
      t += COVER_SECONDS
      input.onProgress?.(++done, total)
    }
    for (let i = 0; i < input.count; i++) {
      const bmp = await input.getPage(i)
      draw(renderPage(bmp, input.design, width))
      bmp.close()
      const last = i === input.count - 1
      const duration = 1 / input.fps + (last ? END_HOLD_SECONDS : 0)
      await source.add(t, duration)
      t += duration
      input.onProgress?.(++done, total)
    }
    await output.finalize()
  } catch (e) {
    await output.cancel().catch(() => {})
    throw e
  }
  return new Blob([output.target.buffer!], { type: 'video/mp4' })
}
