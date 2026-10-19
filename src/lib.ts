import { norm } from './areas'

/** Origin of the news/forum proxy (a Cloudflare Worker in production; empty = Vite's dev proxy). */
const API = (import.meta.env.VITE_PROXY_URL as string | undefined) ?? ''

export type Level = 'street' | 'district' | 'city' | 'state' | 'country'
export type Part = { level: Level; name: string }
export type Place = { lat: number; lon: number; cc?: string; parts: Part[]; cat?: string; alert?: string[] } // parts: most specific first
export type Article = { url: string; title: string; source: string; date: Date; forum?: boolean; orig?: string; approx?: boolean }

const PHOTON = 'https://photon.komoot.io'

type Feat = { geometry: { coordinates: [number, number] }; properties: Record<string, string> }

function toPlace(f: Feat): Place {
  const p = f.properties
  const [lon, lat] = f.geometry.coordinates
  const parts: Part[] = []
  const add = (level: Level, name?: string) => {
    if (name && !parts.some((x) => x.name === name)) parts.push({ level, name })
  }
  add('street', p.street || (p.type === 'street' ? p.name : undefined))
  add('district', p.district || p.locality || (p.type === 'district' || p.type === 'locality' ? p.name : undefined))
  add('city', p.city || (p.type === 'city' ? p.name : undefined) || p.county)
  add('state', p.state || (p.type === 'state' ? p.name : undefined))
  add('country', p.country)
  return { lat, lon, parts, cc: p.countrycode }
}

// Place names always stay in the place's own language (the app language only translates the headlines)
const pl = (_lang: string) => 'default'

async function photon(q: string, lang: string): Promise<Place[]> {
  const r = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lang=${pl(lang)}`)
  if (!r.ok) throw new Error('err.search')
  return ((await r.json()).features as Feat[]).map(toPlace).filter((p) => p.parts.length)
}

type NomHit = { lat: string; lon: string; name: string; namedetails?: { name?: string }; address: Record<string, string> }

/** Nominatim finds towns, suburbs and villages that Photon ranks below streets (e.g. the suburb Kista). */
async function nominatim(q: string): Promise<Place[]> {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&namedetails=1&limit=5&featureType=settlement&accept-language=zz`) // an unknown language makes Nominatim answer with the local names
  if (!r.ok) return []
  return ((await r.json()) as NomHit[]).map((x) => {
    const a = x.address
    const name = x.namedetails?.name ?? x.name
    const parts: Part[] = [{ level: 'city', name }]
    const up = [a.city, a.state, a.municipality].find((v) => v && v !== name)
    if (up) parts.push({ level: 'state', name: up })
    if (a.country) parts.push({ level: 'country', name: a.country })
    return { lat: +x.lat, lon: +x.lon, cc: a.country_code, parts }
  })
}

/** Photon matches strictly, so "Ribegatan Kista" finds nothing; retry with fewer words until something matches. */
export async function search(q: string, lang = 'en'): Promise<Place[]> {
  const words = q.trim().split(/[\s,]+/).filter(Boolean)
  for (let n = words.length; n >= 1; n--) {
    const text = words.slice(0, n).join(' ')
    const [ph, nom] = await Promise.allSettled([photon(text, lang), nominatim(text)])
    const photonHits = ph.status === 'fulfilled' ? ph.value : []
    const own = new Map(photonHits.map((h) => [label(h), h]))
    // an exact name match first (the suburb Kista), then Photon's list, then the other places; where both know the
    // same label Photon's richer hierarchy wins
    const noms = (nom.status === 'fulfilled' ? nom.value : []).map((h) => own.get(label(h)) ?? h)
    const exact = noms.filter((h) => norm(h.parts[0].name) === norm(text))
    const hits = [...exact, ...photonHits, ...noms]
    if (hits.length) return [...new Map(hits.map((h) => [label(h), h])).values()]
    if (ph.status === 'rejected' && nom.status === 'rejected') throw new Error('err.search')
  }
  return []
}

export async function reverse(lat: number, lon: number, lang = 'en'): Promise<Place | null> {
  const r = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&lang=${pl(lang)}`)
  if (!r.ok) throw new Error('err.place')
  const f = ((await r.json()).features as Feat[])[0]
  return f ? { ...toPlace(f), lat, lon } : null
}

/** Country under a point; Nominatim copes with remote land where Photon's radius search finds nothing. */
export async function reverseCountry(lat: number, lon: number, _lang = 'en'): Promise<Place | null> {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&namedetails=1&lat=${lat}&lon=${lon}`)
  if (!r.ok) throw new Error('err.place')
  const j = (await r.json()) as { address?: { country?: string; country_code?: string }; namedetails?: { name?: string } }
  const a = j.address
  const name = j.namedetails?.name ?? a?.country // the country's own name for itself
  return a && name ? { lat, lon, cc: a.country_code, parts: [{ level: 'country', name }] } : null // null over open sea
}

// Bing News RSS via the /bn proxy (Vite dev proxy, a Worker in production; Google News blocks Cloudflare's IPs). Headline + source + link only.
// shortcut: Bing returns ~14 items per feed and only knows past hour/day/week/month, so history is thinner than Google's; no archive dates.
const EDITION: Record<string, string> = { SE: 'sv', TR: 'tr', DE: 'de', FR: 'fr', ES: 'es', AE: 'ar', GB: 'en-GB', US: 'en-US' }
// Bing caps every feed at ~14 items, so deep searches also ask "<place> <topic word>" in the local language to reach more stories.
const WORDS: Record<string, string> = {
  SE: 'polis brand trafik skola bostad kommun idrott olycka', TR: 'polis yangın trafik okul belediye spor kaza', DE: 'Polizei Feuer Verkehr Schule Gemeinde Sport Unfall',
  FR: 'police incendie circulation école mairie sport accident', ES: 'policía incendio tráfico colegio ayuntamiento deporte accidente', AE: 'شرطة حريق مرور مدرسة بلدية رياضة حادث',
  GB: 'police fire traffic school council sport crash', US: 'police fire traffic school council sport crash',
}
const interval = (when: string) => { const m = /^(\d+)([hdy])$/.exec(when); if (!m) return ''; const h = +m[1] * { h: 1, d: 24, y: 8760 }[m[2] as 'h' | 'd' | 'y']; return h <= 1 ? 4 : h <= 24 ? 7 : h <= 168 ? 8 : h <= 720 ? 9 : '' }

async function headlines(query: string, country: string, when: string): Promise<Article[]> {
  const cc = country in EDITION ? country : 'US'
  const iv = interval(when)
  const r = await fetch(`${API}/bn/news/search?q=${encodeURIComponent(query)}&format=rss&cc=${cc}&setlang=${EDITION[cc]}&sortbydate=1${iv ? `&qft=${encodeURIComponent(`interval="${iv}"`)}` : ''}`, { cache: 'no-store' })
  if (!r.ok) throw new Error('err.source')
  const doc = new DOMParser().parseFromString(await r.text(), 'text/xml')
  const seen = new Set<string>()
  return [...doc.querySelectorAll('item')]
    .map((i) => {
      const link = i.querySelector('link')?.textContent ?? ''
      let url = link
      try { url = new URL(link).searchParams.get('url') ?? link } catch { /* keep Bing's redirect link */ }
      return {
        url,
        title: i.querySelector('title')?.textContent ?? '',
        source: i.getElementsByTagNameNS('*', 'Source')[0]?.textContent ?? '',
        date: new Date(i.querySelector('pubDate')?.textContent ?? ''),
      }
    })
    .filter((a) => a.url && !seen.has(a.title) && seen.add(a.title))
}

/** Reddit posts mentioning the place (RSS search, via the /rd proxy). Communities, not publishers. */
const redditCache = new Map<string, { at: number; rows: Article[] }>()

async function reddit(query: string, max: number, sub = '', after = ''): Promise<Article[]> {
  // Reddit answers 429 to repeated searches, so reuse results for 5 minutes
  const ck = `${sub}|${query}|${after}`
  const hit = redditCache.get(ck)
  if (hit && Date.now() - hit.at < 300_000) return hit.rows
  const rows = await redditFetch(query, max, sub, after)
  redditCache.set(ck, { at: Date.now(), rows })
  return rows
}

async function redditFetch(query: string, max: number, sub: string, after: string): Promise<Article[]> {
  const base = sub ? `${API}/rd/r/${sub}/search.rss?restrict_sr=1&` : `${API}/rd/search.rss?`
  const r = await fetch(`${base}q=${encodeURIComponent(query)}&sort=new&limit=${Math.min(max, 100)}${after ? `&after=${after}` : ''}`, { cache: 'no-store' })
  if (!r.ok) throw new Error('err.source')
  const doc = new DOMParser().parseFromString(await r.text(), 'text/xml')
  return [...doc.querySelectorAll('entry')]
    .map((e) => ({
      url: e.querySelector('link')?.getAttribute('href') ?? '',
      title: e.querySelector('title')?.textContent ?? '',
      source: `reddit ${e.querySelector('category')?.getAttribute('label') ?? ''}`.trim(),
      date: new Date(e.querySelector('updated')?.textContent ?? ''),
      forum: true,
    }))
    .filter((a) => a.url.includes('/comments/') && a.title)
}

/** What to search for: the chosen place plus its parent for context, and a word every real hit must contain. */
function target(place: Place, from: number) {
  const [own, ...up] = place.parts.slice(from)
  const ctx = up.find((x) => x.level === 'city') ?? up[0]
  // the parent only disambiguates small places; adding it to a city ("Kista" "Stockholm") drops headlines that just say Kista.
  // Small places try the nearest parent (Kista) and the city (Stockholm): the nearest one is what local papers write.
  const small = ['street', 'district'].includes(own.level)
  const queries = small ? [...new Set([up[0], ctx].filter(Boolean).map((c) => `"${own.name}" "${c.name}"`))] : [`"${own.name}"`]
  const query = queries[0]
  // small places: the longest word of the name must appear in the title (substring, so Turkish/Swedish endings still match)
  const key = ['street', 'district'].includes(own.level) ? norm(own.name).split(' ').filter((w) => w.length >= 4).sort((x, y) => y.length - x.length)[0] : undefined
  // forums match on the whole post text, not just titles, so no title filter; add the parent only for small places
  const fq = [own, ['street', 'district'].includes(own.level) ? ctx : undefined].filter(Boolean).map((x) => x!.name).join(' ')
  return { own, query, queries, key, fq }
}

function mergeAll(lists: Article[][], key: string | undefined, want: number) {
  return lists
    .flat()
    .filter((a) => !isNaN(+a.date))
    .filter((a, i, all) => all.findIndex((b) => b.url === a.url || norm(b.title) === norm(a.title)) === i) // same story from several queries
    .filter((a) => !key || norm(a.title).includes(key)) // search engines match loosely; keep only items that really name the place
    .sort((a, b) => +b.date - +a.date)
    .slice(0, want)
}

/** News for exactly the chosen place. No fallback to a bigger area: no hits means no hits. */
// A Google News feed holds ~100 items and is not sorted by date. Each time window is a nested subset, so a window that comes back
// with fewer than FULL items is complete for its whole horizon. Digging up the ladder until we have `want` items from a complete
// window therefore yields the true newest ones.
const LADDER = ['1h', '1d', '7d', '30d']
const FULL = 10 // Bing's feed holds ~14 items, so 10+ means the window may be cut off

const SRC = 'newzlocal.sources'
export const loadSources = (): string[] => {
  try { return JSON.parse(localStorage.getItem(SRC) ?? '[]') } catch { return [] }
}
export const saveSources = (l: string[]) => {
  try { localStorage.setItem(SRC, JSON.stringify(l)) } catch { /* private mode */ }
}

const day = (d: Date) => d.toISOString().slice(0, 10)

const newsCache = new Map<string, { at: number; r: { articles: Article[]; scope: string; query: string } }>()

/** `onPartial` gets the list as soon as the first answer is in and again after every deeper window, so the screen fills at once. */
export async function news(place: Place, from: number, want: number, deep = true, onPartial?: (r: { articles: Article[]; scope: string; query: string }) => void, monthsBack = 0) {
  const { own, queries, key } = target(place, from)
  const cc = place.cc?.toUpperCase() ?? 'US'
  const small = ['street', 'district'].includes(own.level)
  const editions = [...new Set(deep && !small ? [cc in EDITION ? cc : 'US', 'US'] : [cc])]
  const ck = `${queries.join('|')}|${cc}|${monthsBack}`
  const hit = deep ? newsCache.get(ck) : undefined
  if (hit) {
    onPartial?.(hit.r) // show what we had at once ...
    if (Date.now() - hit.at < 60_000) return hit.r // ... and skip the refetch if it is under a minute old
  }
  let ok = 0
  const lists: Article[][] = []
  const emit = () => onPartial?.({ articles: mergeAll(lists, key, want), scope: own.name, query: queries[0] })
  // one window in every edition; returns the largest feed size so the caller can tell whether it was cut off
  const win = async (q: string, w: string) => {
    const got = await Promise.allSettled(editions.map((e) => headlines(q, e, w)))
    got.forEach((x) => { if (x.status === 'fulfilled') { ok++; lists.push(x.value) } })
    emit()
    return Math.max(0, ...got.map((x) => (x.status === 'fulfilled' ? x.value.length : 0)))
  }
  if (monthsBack > 0) {
    // archive: a month-wide window around the chosen date (Google's after:/before: operators)
    const mid = Date.now() - monthsBack * 30.4 * 864e5
    const w = `after:${day(new Date(mid - 15 * 864e5))} before:${day(new Date(mid + 15 * 864e5))}`
    for (const q of queries) await win(q, w)
    if (!ok) throw new Error('err.source')
    const r = { articles: mergeAll(lists, key, want), scope: own.name, query: queries[0] }
    newsCache.set(ck, { at: Date.now(), r })
    return r
  }
  for (const q of queries) {
    if (!deep) { await win(q, '1d'); continue }
    if ((await win(q, '')) < FULL) continue // the whole feed fits: nothing is cut off
    const seen = new Set<string>()
    for (const w of LADDER) {
      const before = lists.length
      const size = await win(q, w)
      lists.slice(before).flat().forEach((x) => seen.add(norm(x.title)))
      if (seen.size >= want && size < FULL) break
    }
  }
  if (deep) for (const q of queries.slice(0, 1)) {
    for (const e of editions) {
      const w = (WORDS[e] ?? WORDS.US).split(' ')
      const got = await Promise.allSettled(w.map((x) => headlines(`${q} ${x}`, e, '')))
      got.forEach((x) => { if (x.status === 'fulfilled') lists.push(x.value) })
    }
    emit()
  }
  // the user's own news sites: Google News restricted to each domain
  if (deep) for (const d of loadSources()) await win(`${queries[0]} site:${d}`, '')
  if (!ok) throw new Error('err.source')
  const r = { articles: mergeAll(lists, key, want), scope: own.name, query: queries[0] }
  if (deep) newsCache.set(ck, { at: Date.now(), r })
  return r
}

/** The country's own communities on Reddit, where the posts are in the local language (r/Turkey, r/sweden, r/de ...). */
const SUBS: Record<string, string[]> = {
  TR: ['Turkey', 'CasualTR', 'kafalar', 'Turkiye'], SE: ['sweden', 'sverige', 'stockholm'], DE: ['de', 'germany', 'berlin'],
  FR: ['france', 'French', 'paris'], ES: ['spain', 'es', 'madrid'], GB: ['unitedkingdom', 'CasualUK', 'london'], AE: ['dubai', 'UAE'],
  NL: ['thenetherlands'], IT: ['italy'], PL: ['Polska'], BR: ['brasil'], MX: ['mexico'], IN: ['india'], JP: ['japan'], RU: ['russia'], GR: ['greece'],
  IR: ['Iran'], EG: ['egypt'], SA: ['saudiarabia'], US: ['AskNYC', 'nyc', 'LosAngeles', 'chicago', 'houston', 'unitedstatesofamerica'],
}

const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms))

/** Hacker News stories (open Algolia API): English-language discussion, mostly tech and cities abroad. */
async function hackerNews(query: string, max: number): Promise<Article[]> {
  const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${Math.min(max, 50)}`)
  if (!r.ok) throw new Error('err.source')
  const j = (await r.json()) as { hits: { objectID: string; title: string; created_at_i: number }[] }
  return j.hits.map((h) => ({ url: `https://news.ycombinator.com/item?id=${h.objectID}`, title: h.title, source: 'hacker news', date: new Date(h.created_at_i * 1000), forum: true }))
}

/** Stack Exchange questions (open API) from the travel and expat sites. */
async function stackExchange(query: string, site: string, max: number): Promise<Article[]> {
  const r = await fetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${encodeURIComponent(query)}&site=${site}&pagesize=${Math.min(max, 50)}`)
  if (!r.ok) throw new Error('err.source')
  const j = (await r.json()) as { items: { link: string; title: string; creation_date: number }[] }
  const dec = (t: string) => new DOMParser().parseFromString(t, 'text/html').documentElement.textContent ?? t
  return j.items.map((q) => ({ url: q.link, title: dec(q.title), source: `stack exchange ${site}`, date: new Date(q.creation_date * 1000), forum: true }))
}

// Flashback numbers its threads in creation order but the search shows only the last reply's date. Known first-post dates give
// a piecewise-linear estimate of when a thread was created (good to a few weeks, enough to rank it against other sources).
const FB_ANCHORS: [number, string][] = [[2720053, '2016-05-13T11:34:00'], [3507628, '2023-02-08T06:09:00'], [3748124, '2026-10-04T04:15:00']]
export function flashbackCreated(id: number): Date {
  const pts = FB_ANCHORS.map(([i, d]) => [i, +new Date(d)] as const)
  const [a, b] = id <= pts[1][0] ? [pts[0], pts[1]] : [pts[1], pts[2]]
  // beyond the newest anchor keep the recent pace; before the oldest, the oldest pace
  return new Date(a[1] + ((id - a[0]) / (b[0] - a[0])) * (b[1] - a[1]))
}

let fbNext = 0
const fbCache = new Map<string, { at: number; rows: Article[] }>()

/**
 * Flashback's public thread search (via the /fb proxy), 20 threads per sort order. Its robots.txt allows /sok but asks
 * for a 5 s crawl delay, so requests are spaced 5.2 s apart and every page is cached for 5 minutes.
 */
async function flashbackPage(query: string, order: string): Promise<Article[]> {
  const url = `${API}/fb/sok/?query=${encodeURIComponent(query)}&so=${order}`
  const hit = fbCache.get(url)
  if (hit && Date.now() - hit.at < 300_000) return hit.rows
  const wait = fbNext - Date.now()
  fbNext = Math.max(Date.now(), fbNext) + 5200
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  const r = await fetch(url)
  if (!r.ok) throw new Error('err.source')
  const doc = new DOMParser().parseFromString(new TextDecoder('iso-8859-1').decode(await r.arrayBuffer()), 'text/html')
  const rows = [...doc.querySelectorAll('td.td_title')].flatMap((td) => {
    const a = td.querySelector('a[id^="thread_title_"]')
    const m = td.closest('tr')?.querySelector('td.td_last_post')?.textContent?.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/)
    if (!a || !m) return []
    const section = td.querySelector('.thread-forum-title')?.textContent?.trim()
    const id = Number(a.getAttribute('href')!.match(/\/t(\d+)/)?.[1])
    if (!id) return []
    return [{
      url: new URL(a.getAttribute('href')!, 'https://www.flashback.org').href,
      title: a.textContent!.trim(),
      source: `flashback${section ? ` · ${section}` : ''}`,
      date: flashbackCreated(id), // when the thread was started, not when the last reply came
      approx: true,
      forum: true,
    }]
  })
  fbCache.set(url, { at: Date.now(), rows })
  return rows
}

/**
 * The latest forum posts about the chosen place, from the country's own communities as far as there are open sources:
 * Flashback (Sweden), Reddit (worldwide search plus the country's subreddits in the local language), Hacker News and
 * Stack Exchange. `onPartial` gets the list as each source answers.
 */
export async function forum(place: Place, from: number, want = 100, onPartial?: (r: { articles: Article[]; scope: string; query: string }) => void) {
  const { own, fq } = target(place, from)
  const cc = place.cc?.toUpperCase() ?? ''
  // forum search engines match whole posts; keep the ones whose title names the place (not for names without latin letters)
  const fkey = norm(own.name).split(' ').filter((w) => w.length >= 4).sort((x, y) => y.length - x.length)[0]
  const named = (l: Article[]) => (fkey ? l.filter((x) => norm(x.title).includes(fkey)) : l)
  const rq = fq.replace(/ı/g, 'i').replace(/İ/g, 'I') // Reddit finds nothing for Turkish dotless i ("Diyarbakır"), but plenty for "Diyarbakir"
  const acc = new Map<string, Article>()
  const snapshot = () => ({
    articles: [...acc.values()].filter((a) => !isNaN(+a.date)).sort((a, b) => +b.date - +a.date).slice(0, want),
    scope: own.name,
    query: fq,
  })
  const add = (list: Article[]) => { list.forEach((a) => acc.set(a.url, a)); onPartial?.(snapshot()) }
  // Flashback's page parameter is ignored by its server, so more threads come from different sort orders: latest post, thread start, most replies
  const flashback = async () => { for (const order of ['pd', 'td', 'rd']) add(await flashbackPage(fq, order)) }
  // countries without a listed subreddit try r/<English country name>, which exists for most countries (r/Poland, r/Norway ...)
  const english = cc && cc.length === 2 ? new Intl.DisplayNames('en', { type: 'region' }).of(cc) : undefined
  const subList = SUBS[cc] ?? (english ? [english.replace(/[^A-Za-z]/g, '')] : [])
  // shortcut: Reddit answers 429 to a second unauthenticated search within ~10 s, so only the country's main subreddit is asked,
  // 11 s after the worldwide search. More subreddits need the OAuth API behind a server.
  // a Reddit search page holds 100 posts (newest first); ask for the next page only if this one was full and we still need more
  const redditPages = async () => {
    let after = ''
    for (let page = 0; page < 3; page++) {
      if (page) await sleep(11_000)
      const rows = await reddit(rq, want, '', after)
      add(named(rows))
      const last = rows[rows.length - 1]?.url.match(/\/comments\/(\w+)/)?.[1]
      if (rows.length < 90 || !last || [...acc.values()].length >= want) break
      after = `t3_${last}`
    }
  }
  const subs = async () => { for (const sub of subList.slice(0, 1)) { await sleep(11_000); add(named(await reddit(rq, want, sub))) } }
  const got = await Promise.allSettled([
    redditPages(),
    subs(),
    hackerNews(rq, want).then((l) => add(named(l))),
    stackExchange(rq, 'travel', want).then((l) => add(named(l))),
    stackExchange(rq, 'expatriates', want).then((l) => add(named(l))),
    ...(cc === 'SE' ? [flashback()] : []),
  ])
  if (got.every((x) => x.status === 'rejected')) throw (got[0] as PromiseRejectedResult).reason
  return snapshot()
}

const tcache = new Map<string, string>()

/**
 * Translates headlines into the app language (place names are not touched, only the article titles).
 * Uses Google's keyless web endpoint in batches; fine for development, swap for the official
 * Cloud Translation / DeepL API behind the Worker before launch. Falls back to the original titles.
 */
export async function translate(list: Article[], lang: string): Promise<Article[]> {
  const todo = [...new Set(list.map((a) => a.title).filter((t) => !tcache.has(`${lang}|${t}`)))]
  const chunks: string[][] = []
  for (let i = 0; i < todo.length; i += 25) chunks.push(todo.slice(i, i + 25))
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const r = await fetch(`https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${lang}&dt=t`, {
          method: 'POST',
          body: chunk.map((t) => `q=${encodeURIComponent(t)}`).join('&'),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(8000),
        })
        if (!r.ok) return
        const out = (await r.json()) as ([string, string] | string)[]
        chunk.forEach((t, i) => {
          const o = out[i]
          const text = Array.isArray(o) ? o[0] : o
          if (typeof text === 'string' && text) tcache.set(`${lang}|${t}`, text)
        })
      } catch { /* keep the original titles */ }
    }),
  )
  return list.map((a) => ({ ...a, orig: a.title, title: tcache.get(`${lang}|${a.title}`) ?? a.title }))
}

const FAV = 'newzlocal.favs'
export const loadFavs = (): Place[] => {
  try { return JSON.parse(localStorage.getItem(FAV) ?? '[]') } catch { return [] }
}
export const saveFavs = (f: Place[]) => {
  try { localStorage.setItem(FAV, JSON.stringify(f)) } catch { /* private mode */ }
}
export type Quiet = { on: boolean; from: string; to: string }
export const QUIET0: Quiet = { on: false, from: '22:00', to: '07:00' }
/** Quiet hours per favourites category. */
export const loadQuiet = (): Record<string, Quiet> => {
  try { return JSON.parse(localStorage.getItem('newzlocal.quietCats') ?? '{}') } catch { return {} }
}
export const saveQuiet = (q: Record<string, Quiet>) => {
  try { localStorage.setItem('newzlocal.quietCats', JSON.stringify(q)) } catch { /* private mode */ }
}
/** Is `now` inside the quiet hours (which may wrap past midnight)? */
export const inQuiet = (q: Quiet | undefined, now = new Date()) => {
  if (!q?.on) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const [fh, fm] = q.from.split(':').map(Number)
  const [th, tm] = q.to.split(':').map(Number)
  const f = fh * 60 + fm, e = th * 60 + tm
  return f <= e ? m >= f && m < e : m >= f || m < e
}

/** The last list shown for a place, kept so the app still has something to show offline. */
export const saveLast = (key: string, list: Article[]) => {
  try { localStorage.setItem(`newzlocal.last.${key}`, JSON.stringify(list.slice(0, 60))) } catch { /* full or private mode */ }
}
export const loadLast = (key: string): Article[] | null => {
  try {
    const raw = JSON.parse(localStorage.getItem(`newzlocal.last.${key}`) ?? 'null') as (Omit<Article, 'date'> & { date: string })[] | null
    return raw ? raw.map((a) => ({ ...a, date: new Date(a.date) })) : null
  } catch { return null }
}

const CATS = 'newzlocal.cats'
export const loadCats = (): string[] => {
  try { return JSON.parse(localStorage.getItem(CATS) ?? '[]') } catch { return [] }
}
export const saveCats = (c: string[]) => {
  try { localStorage.setItem(CATS, JSON.stringify(c)) } catch { /* private mode */ }
}
export const label = (p: Place) => p.parts.slice(0, 3).map((x) => x.name).join(', ')
