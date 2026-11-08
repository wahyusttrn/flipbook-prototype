export function SetupNotice() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="font-display text-3xl">Almost there</h1>
      <p className="mt-3 text-stone-600">
        Supabase isn't configured yet. Fill in the values in <code className="rounded bg-stone-200 px-1">.env</code>{' '}
        (see <code className="rounded bg-stone-200 px-1">.env.example</code>), run{' '}
        <code className="rounded bg-stone-200 px-1">supabase/schema.sql</code> in the Supabase SQL editor, then restart{' '}
        <code className="rounded bg-stone-200 px-1">pnpm dev</code>.
      </p>
    </div>
  )
}
