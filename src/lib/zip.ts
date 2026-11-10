import { zipSync } from 'fflate'

/** Bundle files into a .zip in the browser. Level 0: JPEGs don't compress further. */
export async function zipFiles(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const entries = await Promise.all(
    files.map(async (f) => [f.name, new Uint8Array(await f.blob.arrayBuffer())] as const),
  )
  return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: 'application/zip' })
}

/** page-001.jpg … so files sort in flipbook order everywhere. */
export const pageFileName = (i: number) => `page-${String(i + 1).padStart(3, '0')}.jpg`
