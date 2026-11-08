import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { isSupabaseConfigured } from '../lib/supabase'
import { SetupNotice } from './SetupNotice'
import { Spinner } from './ui'
import { useAuth } from './useAuth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useAuth()
  const location = useLocation()
  if (!isSupabaseConfigured) return <SetupNotice />
  if (session === undefined) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return children
}
