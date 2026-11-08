import { useEffect } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Spinner } from './ui'

const RELOAD_KEY = 'flipbook:chunk-reload'

/** A lazy chunk failed to load (new deploy, flaky network, dev re-optimize). */
function isChunkError(error: unknown) {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|Loading chunk/i.test(error.message)
  )
}

/** True the first time in this tab; false after we've already reloaded once (avoids loops). */
function firstChunkFailure() {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return false
    sessionStorage.setItem(RELOAD_KEY, '1')
    return true
  } catch {
    return false
  }
}

export function RouteError() {
  const error = useRouteError()
  const autoReload = isChunkError(error) && firstChunkFailure()

  useEffect(() => {
    if (autoReload) window.location.reload()
  }, [autoReload])

  if (autoReload) return <PageSpinner />

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error'

  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-3xl">Something went wrong</h1>
        <p className="mt-3 text-sm break-words text-stone-600">{message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white"
        >
          Reload
        </button>
      </div>
    </div>
  )
}

export function PageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Spinner />
    </div>
  )
}
