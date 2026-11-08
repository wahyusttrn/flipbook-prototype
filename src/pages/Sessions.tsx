import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { SessionStatus } from '../components/SessionStatus'
import { Button, Card, ErrorText, Spinner } from '../components/ui'
import { DAY_MS, formatDateTime } from '../lib/format'
import { SESSION_DAYS, type Session } from '../lib/shared'
import { randomSlug } from '../lib/slug'
import { supabase } from '../lib/supabase'

type Row = Session & { photos: { count: number }[] }

export function Sessions() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    supabase
      .from('sessions')
      .select('*, photos(count)')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) setError(error)
        else setRows(data as Row[])
      })
  }, [])

  async function create(e: FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    const { data, error } = await supabase
      .from('sessions')
      .insert({
        slug: randomSlug(),
        name: name.trim(),
        expires_at: new Date(Date.now() + SESSION_DAYS * DAY_MS).toISOString(),
      })
      .select()
      .single()
    setCreating(false)
    if (error) return setError(error)
    navigate(`/admin/sessions/${data.id}`)
  }

  const q = filter.trim().toLowerCase()
  const visible = rows?.filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm">
            <span className="text-stone-600">New session</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Customer name or booking no. (optional)"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
            />
          </label>
          <Button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create session'}
          </Button>
        </form>
      </Card>

      <ErrorText error={error} />

      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl">Sessions</h1>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search…"
          className="w-48 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-stone-900"
        />
      </div>

      {!visible ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <p className="text-sm text-stone-500">No sessions yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200 overflow-hidden rounded-2xl bg-white ring-1 ring-stone-200">
          {visible.map((s) => (
            <li key={s.id}>
              <Link to={`/admin/sessions/${s.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-stone-50">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.name || <span className="text-stone-400">Untitled</span>}</p>
                  <p className="text-xs text-stone-500">
                    {formatDateTime(s.created_at)} · /s/{s.slug}
                  </p>
                </div>
                <span className="text-sm text-stone-500 tabular-nums">{s.photos[0]?.count ?? 0} photos</span>
                <SessionStatus session={s} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
