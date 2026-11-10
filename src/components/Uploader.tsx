import { useRef, useState, type DragEvent } from 'react'
import { adminApi } from '../lib/api'
import { prepareUpload } from '../lib/image'
import type { Photo } from '../lib/shared'
import { Spinner } from './ui'

const CONCURRENCY = 2

/**
 * Drop camera photos (resized in the browser, then uploaded through the API) or a video take
 * (handed to onVideo, which turns it into flipbook pages locally).
 */
export function Uploader({
  sessionId,
  onUploaded,
  onVideo,
}: {
  sessionId: string
  onUploaded: (p: Photo) => void
  onVideo: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [failed, setFailed] = useState<string[]>([])

  async function upload(files: File[]) {
    const video = files.find(isVideo)
    if (video) onVideo(video)
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length || progress) return
    setFailed([])
    setProgress({ done: 0, total: images.length })
    const queue = [...images]
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          const prepared = await prepareUpload(f)
          onUploaded(await adminApi.uploadPhoto({ sessionId, kind: 'raw', ...prepared }))
        } catch (e) {
          console.error(e)
          setFailed((prev) => [...prev, `${f.name}: ${e instanceof Error ? e.message : 'failed'}`])
        }
        setProgress((p) => p && { ...p, done: p.done + 1 })
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    setProgress(null)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    upload(Array.from(e.dataTransfer.files))
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        disabled={!!progress}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-sm transition-colors ${
          over ? 'border-stone-900 bg-stone-100' : 'border-stone-300 bg-white hover:border-stone-500'
        }`}
      >
        {progress ? (
          <>
            <Spinner />
            <span className="text-stone-600">
              Uploading {progress.done} / {progress.total}…
            </span>
            <span className="h-1.5 w-48 overflow-hidden rounded-full bg-stone-200">
              <span
                className="block h-full bg-stone-900 transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">Drop photos or a video here, or click to choose</span>
            <span className="text-stone-500">
              Photos: JPEG or PNG, resized before upload. Video (MP4/MOV): turned into flipbook pages on this computer.
            </span>
          </>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.mov,.mp4,.m4v,.webm"
        multiple
        hidden
        onChange={(e) => {
          upload(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      {failed.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {failed.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Some systems report .mov files with an empty type, so also check the extension. */
function isVideo(f: File) {
  return f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(f.name)
}
