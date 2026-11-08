// Browser-side image work: resizing uploads, composing frames, detecting frame holes.
import { RAW_MAX_EDGE, THUMB_MAX_EDGE, type Slot } from './shared'

/** Decode a file/blob, honouring EXIF rotation from the camera. */
export function decode(source: Blob): Promise<ImageBitmap> {
  return createImageBitmap(source, { imageOrientation: 'from-image' })
}

/** Load an image by URL (same-origin, so the canvas stays readable). Works for PNG and SVG. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Could not load image ${src}`))
    img.src = src
  })
}

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement

function sizeOf(img: Drawable) {
  return img instanceof HTMLImageElement
    ? { w: img.naturalWidth, h: img.naturalHeight }
    : { w: img.width, h: img.height }
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return { c, ctx }
}

export function toBlob(c: HTMLCanvasElement, type: 'image/jpeg' | 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality),
  )
}

/** Scale down so the long edge is at most maxEdge, export as JPEG. */
export async function resizeToJpeg(img: Drawable, maxEdge: number, quality = 0.88) {
  const { w, h } = sizeOf(img)
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)
  const { c, ctx } = canvas(width, height)
  ctx.fillStyle = '#fff' // flatten any transparency
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return { blob: await toBlob(c, 'image/jpeg', quality), width, height }
}

/** Camera file → stored web version + thumbnail. */
export async function prepareUpload(file: Blob) {
  const bmp = await decode(file)
  try {
    const full = await resizeToJpeg(bmp, RAW_MAX_EDGE, 0.88)
    const thumb = await resizeToJpeg(bmp, THUMB_MAX_EDGE, 0.8)
    return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height }
  } finally {
    bmp.close()
  }
}

/** Draw img into slot like CSS object-fit: cover (centered crop). */
export function drawCover(ctx: CanvasRenderingContext2D, img: Drawable, slot: Slot) {
  const { w, h } = sizeOf(img)
  const scale = Math.max(slot.w / w, slot.h / h)
  const sw = slot.w / scale
  const sh = slot.h / scale
  ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh, slot.x, slot.y, slot.w, slot.h)
}

/**
 * Photos go under the overlay, each in its slot. `scale` < 1 renders a cheaper preview.
 * Empty slots are left light grey so it's obvious what's missing.
 */
export function composeFrame(
  template: { width: number; height: number; slots: Slot[] },
  overlay: Drawable,
  photos: (Drawable | null)[],
  scale = 1,
): HTMLCanvasElement {
  const W = Math.round(template.width * scale)
  const H = Math.round(template.height * scale)
  const { c, ctx } = canvas(W, H)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  template.slots.forEach((s, i) => {
    const slot = { x: s.x * scale, y: s.y * scale, w: s.w * scale, h: s.h * scale }
    const photo = photos[i]
    if (photo) drawCover(ctx, photo, slot)
    else {
      ctx.fillStyle = '#e5e5e5'
      ctx.fillRect(slot.x, slot.y, slot.w, slot.h)
    }
  })
  ctx.drawImage(overlay, 0, 0, W, H)
  return c
}

/**
 * Find the photo holes in a frame overlay: connected transparent regions.
 * Works on a downscaled copy for speed, then maps boxes back to full size,
 * padded by one sample so no white gap shows at the hole edges.
 */
export function detectSlots(overlay: Drawable): Slot[] {
  const { w: W, h: H } = sizeOf(overlay)
  const step = Math.max(1, Math.ceil(Math.max(W, H) / 600))
  const w = Math.ceil(W / step)
  const h = Math.ceil(H / step)
  const { ctx } = canvas(w, h)
  ctx.drawImage(overlay, 0, 0, w, h)
  const alpha = ctx.getImageData(0, 0, w, h).data

  const clear = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) clear[i] = alpha[i * 4 + 3] < 32 ? 1 : 0

  const seen = new Uint8Array(w * h)
  const minArea = w * h * 0.005
  const boxes: Slot[] = []
  const stack: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (!clear[start] || seen[start]) continue
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
      for (const n of next) {
        if (n >= 0 && clear[n] && !seen[n]) {
          seen[n] = 1
          stack.push(n)
        }
      }
    }
    if (area < minArea) continue
    const x0 = Math.max(0, (minX - 1) * step)
    const y0 = Math.max(0, (minY - 1) * step)
    const x1 = Math.min(W, (maxX + 2) * step)
    const y1 = Math.min(H, (maxY + 2) * step)
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }

  // Reading order: top-to-bottom rows, left-to-right within a row.
  return boxes.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y))
}
