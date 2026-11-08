import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** False until real values are put in .env (placeholders count as missing). */
export const isSupabaseConfigured = Boolean(
  url && key && !url.includes('YOUR-PROJECT') && !key.startsWith('your-'),
)

export const supabase = createClient(
  isSupabaseConfigured ? url! : 'http://localhost.invalid',
  isSupabaseConfigured ? key! : 'not-configured',
)
