// Cloudflare Worker: CORS proxy for NewzLocal's news and forum sources (/bn, /rd, /fb), cached for 60 s.
const ORIGINS = {
  '/bn': 'https://www.bing.com',
  '/rd': 'https://www.reddit.com',
  '/fb': 'https://www.flashback.org',
}
const ALLOWED = ['https://nrnworld.one', 'http://localhost:5173']

export default {
  async fetch(req) {
    const url = new URL(req.url)
    const origin = req.headers.get('Origin') ?? ''
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: 'Origin' }
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } })
    const prefix = Object.keys(ORIGINS).find((p) => url.pathname.startsWith(p + '/'))
    if (req.method !== 'GET' || !prefix) return new Response('Not found', { status: 404, headers: cors })
    const r = await fetch(ORIGINS[prefix] + url.pathname.slice(prefix.length) + url.search, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
      cf: { cacheTtl: 60, cacheEverything: true },
    })
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') ?? 'text/plain', 'Cache-Control': 'public, max-age=60' } })
  },
}
