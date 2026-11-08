import { useEffect, useState } from 'react'
import { adminApi } from '../lib/api'
import type { PhotoVariant } from '../lib/shared'

const urls = new Map<string, string>()

/** Object URL for an admin-only photo (fetched with the auth header). */
function useAdminImageUrl(id: string, variant: PhotoVariant) {
  const key = `${id}/${variant}`
  const [url, setUrl] = useState(() => urls.get(key) ?? null)
  useEffect(() => {
    let alive = true
    adminApi
      .photoBlob(id, variant)
      .then((blob) => {
        if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob))
        if (alive) setUrl(urls.get(key)!)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id, variant, key])
  return url
}

export function AdminImage({
  id,
  variant = 'thumb',
  className = '',
  alt = '',
}: {
  id: string
  variant?: PhotoVariant
  className?: string
  alt?: string
}) {
  const url = useAdminImageUrl(id, variant)
  return url ? (
    <img src={url} alt={alt} className={className} draggable={false} />
  ) : (
    <div className={`animate-pulse bg-stone-200 ${className}`} />
  )
}
