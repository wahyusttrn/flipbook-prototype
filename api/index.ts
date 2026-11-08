// Vercel Function: every /api/* request lands here (see the rewrite in vercel.json),
// which moves the original path into the `__path` query parameter (Vercel also adds `path`).
import { handleApi, type ServerEnv } from '../server/app.js'

export default {
  fetch(request: Request) {
    const url = new URL(request.url)
    const path = url.searchParams.get('__path')
    if (path !== null) {
      url.pathname = `/api/${path}`
      url.searchParams.delete('__path')
      url.searchParams.delete('path')
    }
    return handleApi(request, process.env as ServerEnv, url)
  },
}
