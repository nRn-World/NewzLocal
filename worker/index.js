// Cloudflare Worker: CORS proxy for NewzLocal's news and forum sources (/bn, /rd, /fb), cached for 60 s.
const ORIGINS = {
  '/bn': 'https://www.bing.com',
  '/rd': 'https://www.reddit.com',
  '/fb': 'https://www.flashback.org',
}
// Keyed APIs: the key is a Worker secret, so it never reaches the browser; only the allowed origins may spend the free quota.
const KEYED = { '/gnews': ['https://gnews.io/api/v4', 'GNEWS_KEY', 'apikey'], '/nd': ['https://newsdata.io/api/1', 'NEWSDATA_KEY', 'apikey'] }
const ALLOWED = ['https://nrnworld.one', 'http://localhost:5173']

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const origin = req.headers.get('Origin') ?? ''
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: 'Origin' }
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } })
    const kp = Object.keys(KEYED).find((p) => url.pathname.startsWith(p + '/'))
    if (kp && req.method === 'GET') {
      if (!ALLOWED.includes(origin)) return new Response('Forbidden', { status: 403 })
      const [base, secret, param] = KEYED[kp]
      const target = new URL(base + url.pathname.slice(kp.length))
      url.searchParams.forEach((v, k) => target.searchParams.set(k, v))
      target.searchParams.set(param, env[secret])
      const r = await fetch(target, { cf: { cacheTtl: 600, cacheEverything: true } }) // 10 min cache: the free plans allow only 100-200 calls a day
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } })
    }
    const prefix = Object.keys(ORIGINS).find((p) => url.pathname.startsWith(p + '/'))
    if (req.method !== 'GET' || !prefix) return new Response('Not found', { status: 404, headers: cors })
    const r = await fetch(ORIGINS[prefix] + url.pathname.slice(prefix.length) + url.search, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
      cf: { cacheTtl: 60, cacheEverything: true },
    })
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') ?? 'text/plain', 'Cache-Control': 'public, max-age=60' } })
  },
}
