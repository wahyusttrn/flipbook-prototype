import { NavLink, Outlet } from 'react-router'
import { supabase } from '../lib/supabase'
import { Button } from './ui'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-200/70'}`

export function AdminLayout() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-stone-50/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
          <span className="font-display mr-3 text-xl">Flipbook</span>
          <NavLink to="/admin" end className={linkClass}>
            Sessions
          </NavLink>
          <NavLink to="/admin/templates" className={linkClass}>
            Frames
          </NavLink>
          <Button variant="ghost" className="ml-auto" onClick={() => supabase.auth.signOut()}>
            Log out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
