import { Link } from 'react-router'

export function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <h1 className="font-display text-4xl">Page not found</h1>
        <Link to="/" className="mt-4 inline-block text-sm text-stone-600 underline">
          Go home
        </Link>
      </div>
    </div>
  )
}
