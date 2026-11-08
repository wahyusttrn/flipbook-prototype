export const DAY_MS = 86_400_000

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function daysLeft(iso: string, now = Date.now()) {
  return Math.ceil((new Date(iso).getTime() - now) / DAY_MS)
}

export function publicLink(slug: string) {
  return `${window.location.origin}/s/${slug}`
}
