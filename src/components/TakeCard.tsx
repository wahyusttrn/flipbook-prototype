import { useEffect, useState } from 'react'
import { adminApi } from '../lib/api'
import { downloadBlob } from '../lib/download'
import { formatDateTime } from '../lib/format'
import type { Photo, Take } from '../lib/shared'
import { pageFileName, zipFiles } from '../lib/zip'
import { FlipbookPlayer } from './FlipbookPlayer'
import { Button, Spinner } from './ui'

/** One video take in the admin: animated preview, download pages, delete. */
export function TakeCard({ take, frames, onDelete }: { take: Take; frames: Photo[]; onDelete: () => void }) {
  const [urls, setUrls] = useState<string[] | null>(null)
  const [zipping, setZipping] = useState(false)
  const ids = frames.map((f) => f.id).join(',')

  useEffect(() => {
    let alive = true
    let created: string[] = []
    Promise.all(ids.split(',').filter(Boolean).map((id) => adminApi.photoBlob(id, 'thumb'))).then((blobs) => {
      created = blobs.map((b) => URL.createObjectURL(b))
      if (alive) setUrls(created)
      else created.forEach((u) => URL.revokeObjectURL(u))
    })
    return () => {
      alive = false
      created.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [ids])

  async function download() {
    setZipping(true)
    try {
      const blobs = await Promise.all(frames.map((f) => adminApi.photoBlob(f.id, 'full')))
      const zip = await zipFiles(blobs.map((blob, i) => ({ name: pageFileName(i), blob })))
      downloadBlob(zip, `flipbook-${take.id.slice(0, 8)}.zip`)
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200">
      {urls ? (
        <FlipbookPlayer frames={urls} fps={take.fps} />
      ) : (
        <div className="grid aspect-video place-items-center rounded-lg bg-stone-200">
          <Spinner />
        </div>
      )}
      <div className="text-sm">
        <p className="font-medium">
          {frames.length} pages · {Math.round(take.fps * 100) / 100} per second
        </p>
        <p className="truncate text-xs text-stone-500">
          {take.source_name || 'video'} · {formatDateTime(take.created_at)}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={download} disabled={zipping || frames.length === 0} className="flex-1">
          {zipping ? 'Zipping…' : 'Download pages'}
        </Button>
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  )
}
