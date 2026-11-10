// Flipbook page rendering, shared by the admin preview, the MP4 and the print PDF so a page
// looks the same everywhere. Pages in storage are never changed; designs are drawn on top.
import { composeFrame, drawCover, loadImage, sizeOf, type Drawable } from './image'
import { publicApi } from './publicApi'
import { FLIPBOOK_PAGE, type FlipbookCover, type Slot } from './shared'

export interface DesignTemplate {
  id: string
  width: number
  height: number
  slots: Slot[]
}

/** A flipbook page design: overlay PNG with one transparent photo hole (incl. the binding margin). */
export interface PageDesign {
  template: DesignTemplate
  overlay: HTMLImageElement
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const overlays = new Map<string, Promise<HTMLImageElement>>()

export async function loadDesign(t: DesignTemplate | null): Promise<PageDesign | null> {
  if (!t) return null
  let p = overlays.get(t.id)
  if (!p) {
    p = loadImage(publicApi.overlayUrl(t.id))
    p.catch(() => overlays.delete(t.id))
    overlays.set(t.id, p)
  }
  return { template: t, overlay: await p }
}

/** Default cover text for a session */
export function defaultCover(sessionName: string): FlipbookCover {
  return {
    enabled: true,
    title: sessionName || 'Our flipbook',
    subtitle: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
  }
}

function blank(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = Math.round(w)
  c.height = Math.round(h)
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  return { c, ctx }
}

/**
 * One page for screens/video, `width` px wide. With a design: photo in the hole, overlay on top.
 * Without: the plain frame, edge to edge.
 */
export function renderPage(src: Drawable, design: PageDesign | null, width: number): HTMLCanvasElement {
  if (design) return composeFrame(design.template, design.overlay, [src], width / design.template.width)
  const { w, h } = sizeOf(src)
  const { c, ctx } = blank(width, (width * h) / w)
  ctx.drawImage(src, 0, 0, c.width, c.height)
  return c
}

/** Where cover text goes: the design's photo hole, or the whole page. */
function photoRect(design: PageDesign | null, canvas: HTMLCanvasElement): Rect {
  if (!design) return { x: 0, y: 0, w: canvas.width, h: canvas.height }
  const k = canvas.width / design.template.width
  const s = design.template.slots[0]
  return { x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k }
}

/** Title + subtitle over a dark gradient at the bottom of the photo. */
async function drawCoverText(canvas: HTMLCanvasElement, rect: Rect, cover: FlipbookCover) {
  // Canvas only uses web fonts once they're loaded.
  await Promise.all([document.fonts.load('600 48px Fraunces'), document.fonts.load('500 24px Inter')]).catch(() => {})
  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.w, rect.h)
  ctx.clip()
  const bandTop = rect.y + rect.h * 0.5
  const g = ctx.createLinearGradient(0, bandTop, 0, rect.y + rect.h)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.72)')
  ctx.fillStyle = g
  ctx.fillRect(rect.x, bandTop, rect.w, rect.h * 0.5)

  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = rect.h * 0.02
  const cx = rect.x + rect.w / 2
  const fit = (text: string, weight: string, size: number, family: string) => {
    let px = size
    do {
      ctx.font = `${weight} ${px}px ${family}`
      px -= 1
    } while (ctx.measureText(text).width > rect.w * 0.9 && px > 6)
  }
  const hasSub = cover.subtitle.trim().length > 0
  fit(cover.title, '600', rect.h * 0.14, 'Fraunces, Georgia, serif')
  ctx.fillText(cover.title, cx, rect.y + rect.h * (hasSub ? 0.8 : 0.88))
  if (hasSub) {
    fit(cover.subtitle, '500', rect.h * 0.065, 'Inter, Helvetica, Arial, sans-serif')
    ctx.globalAlpha = 0.85
    ctx.fillText(cover.subtitle, cx, rect.y + rect.h * 0.91)
  }
  ctx.restore()
}

/** Cover page for screens/video: the first page with the title on it. */
export async function renderCover(src: Drawable, design: PageDesign | null, cover: FlipbookCover, width: number) {
  const c = renderPage(src, design, width)
  await drawCoverText(c, photoRect(design, c), cover)
  return c
}

/** Size of one printed page at print resolution (3×2 in at 300 DPI = 900×600). */
export const PRINT_W = FLIPBOOK_PAGE.widthIn * FLIPBOOK_PAGE.dpi
export const PRINT_H = FLIPBOOK_PAGE.heightIn * FLIPBOOK_PAGE.dpi

/**
 * One printed page (900×600). A design already includes its binding margin; without one we
 * lay the frame out ourselves: white page, binding margin on the left, photo to the right.
 */
export async function renderPrintPage(src: Drawable, design: PageDesign | null, cover?: FlipbookCover) {
  const { c, ctx } = blank(PRINT_W, PRINT_H)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, PRINT_W, PRINT_H)
  let rect: Rect
  if (design) {
    const page = renderPage(src, design, PRINT_W)
    // Designs should be 3:2; if not, fit inside the page.
    const k = Math.min(PRINT_W / page.width, PRINT_H / page.height)
    const w = page.width * k
    const h = page.height * k
    ctx.drawImage(page, (PRINT_W - w) / 2, (PRINT_H - h) / 2, w, h)
    const s = design.template.slots[0]
    const kk = w / design.template.width
    rect = { x: (PRINT_W - w) / 2 + s.x * kk, y: (PRINT_H - h) / 2 + s.y * kk, w: s.w * kk, h: s.h * kk }
  } else {
    const binding = FLIPBOOK_PAGE.bindingIn * FLIPBOOK_PAGE.dpi
    const pad = 18
    const w = PRINT_W - binding - pad * 2
    const h = Math.min((w * 9) / 16, PRINT_H - pad * 2)
    rect = { x: binding + pad, y: (PRINT_H - h) / 2, w, h }
    drawCover(ctx, src, rect)
    // Faint guide where the staples go
    ctx.strokeStyle = '#e5e5e5'
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(binding, 0)
    ctx.lineTo(binding, PRINT_H)
    ctx.stroke()
  }
  if (cover) await drawCoverText(c, rect, cover)
  return c
}
