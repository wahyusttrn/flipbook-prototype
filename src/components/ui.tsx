import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary: 'bg-stone-900 text-white hover:bg-stone-700 disabled:bg-stone-400',
  secondary: 'bg-white text-stone-900 ring-1 ring-stone-300 hover:bg-stone-100 disabled:text-stone-400',
  ghost: 'text-stone-700 hover:bg-stone-200/70 disabled:text-stone-400',
  danger: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50 disabled:text-red-300',
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  )
}

export function Spinner({ className = 'size-6' }: { className?: string }) {
  return (
    <svg className={`animate-spin text-stone-400 ${className}`} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl bg-white p-4 ring-1 ring-stone-200 sm:p-5 ${className}`}>{children}</section>
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</p>
}

const badgeTones = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  grey: 'bg-stone-100 text-stone-600 ring-stone-200',
}

export function Badge({ tone, children }: { tone: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${badgeTones[tone]}`}>
      {children}
    </span>
  )
}
