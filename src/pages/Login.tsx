import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { SetupNotice } from '../components/SetupNotice'
import { Button, ErrorText } from '../components/ui'
import { useAuth } from '../components/useAuth'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

export function Login() {
  const session = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  if (!isSupabaseConfigured) return <SetupNotice />
  if (session) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/admin'} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error)
    setBusy(false)
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 ring-1 ring-stone-200">
        <div>
          <h1 className="font-display text-2xl">Flipbook studio</h1>
          <p className="text-sm text-stone-500">Staff login</p>
        </div>
        <label className="block text-sm">
          <span className="text-stone-600">Email</span>
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
          />
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
          />
        </label>
        <ErrorText error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
