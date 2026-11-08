// Vite plugin: serve /api/* during `pnpm dev` with the same handler the Vercel function uses,
// so local dev needs no Vercel CLI. Env comes from .env (all keys, not just VITE_*).
import { Readable } from 'node:stream'
import { loadEnv, type Plugin } from 'vite'

export function devApi(): Plugin {
  return {
    name: 'flipbook-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        try {
          // Re-read on every request so edits to server/ and .env apply without a restart.
          const env = loadEnv(server.config.mode, server.config.root, '')
          const { handleApi } = (await server.ssrLoadModule('/server/app.ts')) as typeof import('./app.ts')
          const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) {
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
          }
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
          const request = new Request(url, {
            method: req.method,
            headers,
            body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
            duplex: 'half',
          } as RequestInit)
          const response = await handleApi(request, env, url)
          res.statusCode = response.status
          response.headers.forEach((value: string, key: string) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          next(e)
        }
      })
    },
  }
}
