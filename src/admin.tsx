import { AdminLayout } from './components/AdminLayout'
import { RequireAuth } from './components/RequireAuth'

export function AdminRoot() {
  return (
    <RequireAuth>
      <AdminLayout />
    </RequireAuth>
  )
}
