import { daysLeft } from '../lib/format'
import type { Session } from '../lib/shared'
import { Badge } from './ui'

export function SessionStatus({ session }: { session: Pick<Session, 'expires_at' | 'purged_at'> }) {
  if (session.purged_at) return <Badge tone="grey">Files deleted</Badge>
  const d = daysLeft(session.expires_at)
  if (d <= 0) return <Badge tone="red">Expired</Badge>
  if (d <= 2) return <Badge tone="amber">{d === 1 ? 'Last day' : `${d} days left`}</Badge>
  return <Badge tone="green">{d} days left</Badge>
}
