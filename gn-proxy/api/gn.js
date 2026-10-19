// Vercel function: CORS proxy for Google News RSS (Google blocks Cloudflare's IPs, so this runs elsewhere). Cached 60 s.
const ALLOWED = ['https://nrnworld.one', 'http://localhost:5173']
export default async function handler(req, res) {
  const origin = req.headers.origin ?? ''
  res.setHeader('Access-Control-Allow-Origin', ALLOWED.includes(origin) ? origin : ALLOWED[0])
  res.setHeader('Vary', 'Origin')
  const q = new URL(req.url, 'http://x').search
  const r = await fetch('https://news.google.com/rss/search' + q, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' } })
  res.setHeader('Cache-Control', 's-maxage=60')
  res.status(r.status).setHeader('Content-Type', 'application/xml').send(await r.text())
}
