// Flipbook → animated GIF, made in the browser (staff: from full pages, customers: from thumbnails).
// Same pages and timing as the MP4. Never stored; the MP4 stays the main output (smaller, full colour).
// No Supabase import: the customer gallery loads this.
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { renderCover, renderPage, type PageDesign } from './flipbook'
import { sizeOf } from './image'
import { COVER_SECONDS, END_HOLD_SECONDS, type FlipbookCover } from './shared'

export interface FlipbookGifInput {
  count: number
  /** Page i as a bitmap; closed after drawing */
  getPage: (i: number) => Promise<ImageBitmap>
  design: PageDesign | null
  cover: FlipbookCover | null
  fps: number
  /** Output width in px (height follows the page shape) */
  width: number
  onProgress?: (done: number, total: number) => void
}

/** Every 2nd pixel of every 2nd row */
function sample(data: Uint8ClampedArray, width: number, height: number) {
  const out = new Uint8ClampedArray(Math.ceil(width / 2) * Math.ceil(height / 2) * 4)
  let o = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      out[o++] = data[i]
      out[o++] = data[i + 1]
      out[o++] = data[i + 2]
      out[o++] = data[i + 3]
    }
  }
  return out
}

export async function makeFlipbookGif(input: FlipbookGifInput): Promise<Blob> {
  const first = await input.getPage(0)
  const natural = input.design ? { w: input.design.template.width, h: input.design.template.height } : sizeOf(first)
  first.close()
  const width = Math.round(input.width)
  const height = Math.round((width * natural.h) / natural.w)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const gif = GIFEncoder()
  const total = input.count + (input.cover?.enabled ? 1 : 0)
  let done = 0
  // GIF delays are whole 1/100 s. Round the running clock, not each frame, so 12/s doesn't drift to 12.5/s.
  let clock = 0
  let written = 0
  const add = async (page: HTMLCanvasElement, seconds: number) => {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(page, 0, 0, width, height)
    const { data } = ctx.getImageData(0, 0, width, height)
    // Own palette per page (the photo changes every page), picked from every 2nd pixel of every
    // 2nd row: halves the total time and looks the same.
    const palette = quantize(sample(data, width, height), 256)
    clock += seconds
    const cs = Math.max(2, Math.round(clock * 100) - written) // browsers slow down delays under 2/100 s
    written += cs
    gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: cs * 10, repeat: 0 })
    input.onProgress?.(++done, total)
    await new Promise((r) => setTimeout(r)) // let the progress label repaint
  }

  if (input.cover?.enabled) {
    const bmp = await input.getPage(0)
    const page = await renderCover(bmp, input.design, input.cover, width)
    bmp.close()
    await add(page, COVER_SECONDS)
  }
  for (let i = 0; i < input.count; i++) {
    const bmp = await input.getPage(i)
    const page = renderPage(bmp, input.design, width)
    bmp.close()
    await add(page, 1 / input.fps + (i === input.count - 1 ? END_HOLD_SECONDS : 0))
  }
  gif.finish()
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' })
}
