// Print-ready flipbook: every page at 3×2 in on A4/Letter sheets, with cut lines, crop marks and
// page numbers in the binding margin. Print at 100%, cut, stack in order, staple on the left.
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { renderPrintPage, type PageDesign } from './flipbook'
import { toBlob } from './image'
import { FLIPBOOK_PAGE, type FlipbookCover } from './shared'

export type Paper = 'a4' | 'letter'

const PAPER: Record<Paper, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] }
const PT = 72
const MARGIN = 36 // keep clear of the printer's unprintable edge
const HEADER = 20
const FOOTER = 20
const INSTRUCTIONS = 'Print at 100% (Actual size). Cut on the grey lines, stack in order with the cover on top, staple on the left.'

export interface FlipbookPdfInput {
  count: number
  getPage: (i: number) => Promise<ImageBitmap>
  design: PageDesign | null
  cover: FlipbookCover | null
  title: string
  paper: Paper
  onProgress?: (done: number, total: number) => void
}

/** Helvetica in PDFs only knows Latin-1; drop anything else (e.g. emoji) instead of failing. */
const latin1 = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim()

export async function makeFlipbookPdf(input: FlipbookPdfInput): Promise<Blob> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Flipbook - ${latin1(input.title)}`)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const [pw, ph] = PAPER[input.paper]
  const cellW = FLIPBOOK_PAGE.widthIn * PT
  const cellH = FLIPBOOK_PAGE.heightIn * PT
  const cols = Math.floor((pw - 2 * MARGIN) / cellW)
  const rows = Math.floor((ph - 2 * MARGIN - HEADER - FOOTER) / cellH)
  const perSheet = cols * rows
  const gridW = cols * cellW
  const x0 = (pw - gridW) / 2
  const yTop = ph - MARGIN - HEADER // top edge of the grid (PDF y grows upwards)

  const hasCover = !!input.cover?.enabled
  const items = (hasCover ? 1 : 0) + input.count
  const sheets = Math.ceil(items / perSheet)
  const grey = rgb(0.75, 0.75, 0.75)
  const header = (n: number) =>
    latin1(`Flipbook - ${input.title} - sheet ${n} of ${sheets} - ${input.count} pages${hasCover ? ' + cover' : ''}`)

  let page = pdf.addPage([pw, ph])
  for (let k = 0; k < items; k++) {
    const pos = k % perSheet
    if (k > 0 && pos === 0) page = pdf.addPage([pw, ph])
    if (pos === 0) {
      const sheet = Math.floor(k / perSheet) + 1
      const usedRows = Math.min(rows, Math.ceil((items - k) / cols))
      page.drawText(header(sheet), { x: x0, y: ph - MARGIN - 10, size: 8, font, color: rgb(0.3, 0.3, 0.3) })
      page.drawText(INSTRUCTIONS, { x: x0, y: yTop - usedRows * cellH - FOOTER + 2, size: 7, font, color: rgb(0.45, 0.45, 0.45) })
      drawCropMarks(page, x0, yTop, cols, usedRows, cellW, cellH)
    }
    const isCover = hasCover && k === 0
    const pageIndex = hasCover ? k - 1 : k
    const bmp = await input.getPage(isCover ? 0 : pageIndex)
    const canvas = await renderPrintPage(bmp, input.design, isCover ? input.cover! : undefined)
    bmp.close()
    const jpg = await pdf.embedJpg(new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer()))

    const col = pos % cols
    const row = Math.floor(pos / cols)
    const x = x0 + col * cellW
    const y = yTop - (row + 1) * cellH
    page.drawImage(jpg, { x, y, width: cellW, height: cellH })
    page.drawRectangle({ x, y, width: cellW, height: cellH, borderColor: grey, borderWidth: 0.4 })
    // Page number, small and vertical, inside the binding margin (hidden by the staples once bound)
    page.drawText(isCover ? 'cover' : String(pageIndex + 1), {
      x: x + 8,
      y: y + 6,
      size: 6.5,
      font,
      color: rgb(0.45, 0.45, 0.45),
      rotate: degrees(90),
    })
    input.onProgress?.(k + 1, items)
  }
  // Copy into a plain ArrayBuffer-backed array (Blob doesn't accept SharedArrayBuffer views).
  return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' })
}

function drawCropMarks(
  page: ReturnType<PDFDocument['addPage']>,
  x0: number,
  yTop: number,
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
) {
  const len = 10
  const gap = 3
  const black = rgb(0, 0, 0)
  const yBottom = yTop - rows * cellH
  for (let c = 0; c <= cols; c++) {
    const x = x0 + c * cellW
    page.drawLine({ start: { x, y: yTop + gap }, end: { x, y: yTop + gap + len }, thickness: 0.5, color: black })
    page.drawLine({ start: { x, y: yBottom - gap }, end: { x, y: yBottom - gap - len }, thickness: 0.5, color: black })
  }
  for (let r = 0; r <= rows; r++) {
    const y = yTop - r * cellH
    page.drawLine({ start: { x: x0 - gap, y }, end: { x: x0 - gap - len, y }, thickness: 0.5, color: black })
    const xr = x0 + cols * cellW
    page.drawLine({ start: { x: xr + gap, y }, end: { x: xr + gap + len, y }, thickness: 0.5, color: black })
  }
}
