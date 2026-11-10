import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AdminImage } from '../components/AdminImage'
import { Composer } from '../components/Composer'
import { QrCode } from '../components/QrCode'
import { SessionStatus } from '../components/SessionStatus'
import { TakeCard } from '../components/TakeCard'
import { Button, Card, ErrorText, Spinner } from '../components/ui'
import { Uploader } from '../components/Uploader'
import { VideoImporter } from '../components/VideoImporter'
import { adminApi } from '../lib/api'
import { downloadBlob } from '../lib/download'
import { DAY_MS, formatDate, publicLink } from '../lib/format'
import type { Photo, Session, Take, Template } from '../lib/shared'
import { supabase } from '../lib/supabase'

const EXTEND_DAYS = 30

export function SessionDetail() {
  const { id } = useParams() as { id: string }
  const navigate = useNavigate()
  const [session, setSession] = useState<Session | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [takes, setTakes] = useState<Take[]>([])
  /** Video currently being turned into flipbook pages */
  const [importing, setImporting] = useState<File | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [showQr, setShowQr] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    Promise.all([
      supabase.from('sessions').select('*').eq('id', id).single(),
      supabase.from('photos').select('*').eq('session_id', id).order('created_at'),
      supabase.from('templates').select('*').order('created_at'),
      supabase.from('takes').select('*').eq('session_id', id).order('created_at'),
    ]).then(([s, p, t, k]) => {
      const err = s.error ?? p.error ?? t.error ?? k.error
      if (err) return setError(err)
      setSession(s.data)
      setPhotos(p.data ?? [])
      setTemplates(t.data ?? [])
      setTakes(k.data ?? [])
    })
  }, [id])

  if (error && !session) return <ErrorText error={error} />
  if (!session) return <Spinner />

  const link = publicLink(session.slug)
  const raw = photos.filter((p) => p.kind === 'raw')
  const framed = photos.filter((p) => p.kind === 'framed')
  const photoFrames = templates.filter((t) => t.kind === 'photo')
  const flipbookDesigns = templates.filter((t) => t.kind === 'flipbook')
  const replaceTake = (t: Take) => setTakes((all) => all.map((x) => (x.id === t.id ? t : x)))
  const framesOf = (takeId: string) =>
    photos.filter((p) => p.take_id === takeId).sort((a, b) => (a.frame_index ?? 0) - (b.frame_index ?? 0))
  const purged = !!session.purged_at

  async function extend() {
    if (!session) return
    const base = Math.max(Date.now(), new Date(session.expires_at).getTime())
    const expires_at = new Date(base + EXTEND_DAYS * DAY_MS).toISOString()
    const { data, error } = await supabase.from('sessions').update({ expires_at }).eq('id', session.id).select().single()
    if (error) setError(error)
    else setSession(data)
  }

  async function rename() {
    if (!session) return
    const name = window.prompt('Session name', session.name)
    if (name === null) return
    const { data, error } = await supabase.from('sessions').update({ name: name.trim() }).eq('id', session.id).select().single()
    if (error) setError(error)
    else setSession(data)
  }

  async function remove() {
    if (!session || !window.confirm('Delete this session and all its photos? This cannot be undone.')) return
    try {
      await adminApi.deleteSession(session.id)
      navigate('/admin')
    } catch (e) {
      setError(e)
    }
  }

  async function removePhoto(p: Photo) {
    if (!window.confirm('Delete this photo?')) return
    try {
      await adminApi.deletePhoto(p.id)
      setPhotos((all) => all.filter((x) => x.id !== p.id))
    } catch (e) {
      setError(e)
    }
  }

  async function removeTake(take: Take) {
    if (!window.confirm('Delete this flipbook take and all its pages?')) return
    try {
      await adminApi.deleteTake(take.id)
      setTakes((all) => all.filter((t) => t.id !== take.id))
      setPhotos((all) => all.filter((p) => p.take_id !== take.id))
    } catch (e) {
      setError(e)
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <Link to="/admin" className="text-sm text-stone-500 hover:text-stone-900">
            ← Sessions
          </Link>
          <h1 className="font-display mt-1 flex items-center gap-3 text-3xl">
            {session.name || 'Untitled session'}
            <button type="button" onClick={rename} className="text-sm font-normal text-stone-400 hover:text-stone-900">
              rename
            </button>
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-stone-500">
            <SessionStatus session={session} />
            <span>Link valid until {formatDate(session.expires_at)}</span>
          </div>
        </div>
        <Button variant="secondary" onClick={extend} disabled={purged}>
          +{EXTEND_DAYS} days
        </Button>
        <Button variant="danger" onClick={remove}>
          Delete
        </Button>
      </div>

      <ErrorText error={error} />

      <Card className="flex flex-col items-center gap-5 sm:flex-row">
        <button type="button" onClick={() => setShowQr(true)} title="Show big QR for the customer">
          <QrCode value={link} size={132} className="rounded-lg" />
        </button>
        <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
          <p className="text-sm text-stone-500">Customer link</p>
          <p className="truncate font-mono text-sm">{link}</p>
          <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
            <Button variant="secondary" onClick={copy}>
              {copied ? 'Copied!' : 'Copy link'}
            </Button>
            <a href={link} target="_blank" rel="noreferrer">
              <Button variant="secondary">Open gallery</Button>
            </a>
            <Button variant="secondary" onClick={() => setShowQr(true)}>
              Show QR to customer
            </Button>
          </div>
        </div>
      </Card>

      {purged ? (
        <Card>
          <p className="text-sm text-stone-600">This session expired and its files were deleted.</p>
        </Card>
      ) : (
        <>
          <Card className="space-y-4">
            <h2 className="font-display text-xl">
              1. Photos & video <span className="text-base text-stone-400">({raw.length} photos)</span>
            </h2>
            <Uploader
              sessionId={session.id}
              onUploaded={(p) => setPhotos((all) => [...all, p])}
              onVideo={setImporting}
            />
            {importing && (
              <VideoImporter
                key={`${importing.name}-${importing.lastModified}-${importing.size}`}
                file={importing}
                sessionId={session.id}
                sessionName={session.name}
                designs={flipbookDesigns}
                onTakeChange={replaceTake}
                onDone={(take, frames) => {
                  setTakes((all) => [...all, take])
                  setPhotos((all) => [...all, ...frames])
                }}
                onClose={() => setImporting(null)}
              />
            )}
            {raw.length > 0 && <PhotoGrid photos={raw} onDelete={removePhoto} />}
          </Card>

          <Card className="space-y-4">
            <h2 className="font-display text-xl">
              2. Flipbook <span className="text-base text-stone-400">({takes.length} {takes.length === 1 ? 'take' : 'takes'})</span>
            </h2>
            {takes.length === 0 ? (
              <p className="text-sm text-stone-500">
                Drop a video above to turn it into flipbook pages. Takes show up here and play in the customer gallery.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {takes.map((t) => (
                  <TakeCard
                    key={t.id}
                    take={t}
                    frames={framesOf(t.id)}
                    designs={flipbookDesigns}
                    sessionName={session.name}
                    onChange={replaceTake}
                    onDelete={() => removeTake(t)}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="font-display text-xl">3. Frame</h2>
            <Composer
              sessionId={session.id}
              rawPhotos={raw}
              templates={photoFrames}
              onSaved={(p) => setPhotos((all) => [...all, p])}
            />
          </Card>

          <Card className="space-y-4">
            <h2 className="font-display text-xl">
              4. Framed results <span className="text-base text-stone-400">({framed.length})</span>
            </h2>
            {framed.length === 0 ? (
              <p className="text-sm text-stone-500">Saved frames show up here and in the customer gallery.</p>
            ) : (
              <PhotoGrid photos={framed} onDelete={removePhoto} large />
            )}
          </Card>
        </>
      )}

      {showQr && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-white p-6"
          onClick={() => setShowQr(false)}
          role="dialog"
          aria-label="QR code"
        >
          <div className="text-center">
            <p className="font-display text-3xl">Scan to get your photos</p>
            <QrCode value={link} size={Math.min(window.innerWidth, window.innerHeight) * 0.6} className="mx-auto my-6" />
            <p className="text-stone-500">Available until {formatDate(session.expires_at)} · tap anywhere to close</p>
          </div>
        </div>
      )}
    </div>
  )
}

function PhotoGrid({ photos, onDelete, large }: { photos: Photo[]; onDelete: (p: Photo) => void; large?: boolean }) {
  return (
    <div className={`grid gap-2 ${large ? 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6' : 'grid-cols-3 sm:grid-cols-6 lg:grid-cols-8'}`}>
      {photos.map((p) => (
        <PhotoTile key={p.id} photo={p} onDelete={onDelete} large={large} />
      ))}
    </div>
  )
}

function PhotoTile({ photo, onDelete, large }: { photo: Photo; onDelete: (p: Photo) => void; large?: boolean }) {
  async function save() {
    downloadBlob(await adminApi.photoBlob(photo.id, 'full'), `${photo.kind}-${photo.id.slice(0, 8)}.jpg`)
  }
  return (
    <div className="group relative overflow-hidden rounded-lg bg-stone-100">
      <AdminImage
        id={photo.id}
        className={`w-full ${large ? 'object-contain' : 'aspect-square object-cover'}`}
      />
      <div className="absolute inset-x-1 bottom-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button type="button" onClick={save} className="rounded-md bg-white/90 px-2 py-1 text-xs font-medium shadow">
          Save
        </button>
        <button
          type="button"
          onClick={() => onDelete(photo)}
          className="rounded-md bg-white/90 px-2 py-1 text-xs font-medium text-red-700 shadow"
        >
          Delete
        </button>
      </div>
    </div>
  )
}
