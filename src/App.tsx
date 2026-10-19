import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { type Article, type Place, inQuiet, label, loadCats, loadFavs, loadLast, loadQuiet, loadSources, news, reverse, reverseCountry, saveCats, saveFavs, saveLast, saveQuiet, saveSources, search, translate, forum } from './lib'
import { LANGS, type Lang, loadLang, saveLang, tr } from './i18n'
import { type Area, at, boundaries, bounds, labelPoint, link, norm } from './areas'
import { SKY, earthStyle } from './mapStyle'
import Paper from './Paper'
import Compare from './Compare'
import { Report, TimeTravel, TopicBar } from './Insights'
import { TOPICS, topicsOf } from './topics'
import { type Street, circle, places, streets, subAreas } from './overpass'
import './index.css'

const same = (a: Place, b: Place) => label(a) === label(b)
const ago = (d: Date, lang: Lang) => {
  const m = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000))
  const f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  return m < 60 ? f.format(-m, 'minute') : m < 1440 ? f.format(-Math.round(m / 60), 'hour') : f.format(-Math.round(m / 1440), 'day')
}
type Ctx = { cc: string; country: string }
type Cur = Ctx & { mode: 1 | 2 | 3; feats: Area[]; sel?: string; state?: string; district?: string } // 1 provinces, 2 districts, 3 neighbourhoods

export default function App() {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const pin = useRef<maplibregl.Marker | null>(null)
  const spin = useRef(true)
  const cur = useRef<Cur | null>(null)
  const hov = useRef<number | string | undefined>(undefined)
  const seq = useRef(0)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Place[]>([])
  const [searched, setSearched] = useState(false)
  const [place, setPlace] = useState<Place | null>(null)
  const [level, setLevel] = useState(0)
  const [res, setRes] = useState<{ articles: Article[]; scope: string; query: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingAreas, setLoadingAreas] = useState(false)
  const [err, setErr] = useState('')
  const [favs, setFavs] = useState<Place[]>(loadFavs)
  const [lang, setLang] = useState<Lang>(loadLang)
  const langRef = useRef(lang)
  const t = (k: Parameters<typeof tr>[1], v?: Record<string, string>) => tr(lang, k, v)
  const te = (m: string) => tr(lang, m.startsWith('err.') ? (m as Parameters<typeof tr>[1]) : 'err.source') // network errors have no key
  const [tick, setTick] = useState(0)
  const [stamp, setStamp] = useState<Date | null>(null)
  const shown = useRef('')
  const [tab, setTab] = useState<'news' | 'forum' | 'favs'>('news')
  const [paperOpen, setPaperOpen] = useState(false)
  const [topic, setTopic] = useState('') // topic filter on the news list
  const [months, setMonths] = useState(0) // 0 = now, else the news from about that many months ago
  const [cmp, setCmp] = useState<string[]>([]) // favourites ticked for comparison
  const [cmpOpen, setCmpOpen] = useState(false)
  const [mine, setMine] = useState<Article[] | null>(null) // "my newspaper": the newest headlines from all favourites
  const [mineBusy, setMineBusy] = useState(false)
  const [quiet, setQuiet] = useState(loadQuiet)
  const [srcs, setSrcs] = useState<string[]>(loadSources)
  const [srcDraft, setSrcDraft] = useState('')
  const [alertOpen, setAlertOpen] = useState('') // favourite whose alert settings are open
  const [copied, setCopied] = useState(false)
  const [offline, setOffline] = useState(false)
  const heat = useRef<Record<string, number>>({}) // headlines mentioning each shown area
  const [cats, setCats] = useState<string[]>(loadCats)
  const [favCat, setFavCat] = useState('') // category filter in the favourites tab, '' = all
  const [drag, setDrag] = useState<{ name: string; x: number; y: number } | null>(null) // a favourite being dragged to a category
  const [over, setOver] = useState<string | null>(null) // category under the pointer while dragging
  const justDragged = useRef(false)
  const [newCat, setNewCat] = useState<string | null>(null) // text of the inline "new category" field while it is open
  const [freshArts, setFreshArts] = useState<Record<string, Article[]>>({}) // the new headlines found in each favourite since you last opened it
  const [only, setOnly] = useState<{ key: string; items: Article[] } | null>(null) // opening a favourite with news shows just those first
  const unread = Object.fromEntries(Object.entries(freshArts).map(([k, v]) => [k, v.length]))
  const [perm, setPerm] = useState<string>(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const [area, setArea] = useState<Area | null>(null) // the district or neighbourhood whose streets are listed
  const [streetList, setStreetList] = useState<Street[] | null>(null)
  const [loadingStreets, setLoadingStreets] = useState(false)
  const [sf, setSf] = useState('')
  const [streetsOpen, setStreetsOpen] = useState(false)

  useEffect(() => { setStreetList(null); setSf('') }, [area])
  useEffect(() => { // the street list is big, so it is only fetched once the user opens it
    if (!area || !streetsOpen) return
    let live = true
    setLoadingStreets(true)
    streets(area).then((r) => live && setStreetList(r)).catch(() => live && setErr('err.areas')).finally(() => live && setLoadingStreets(false))
    return () => { live = false }
  }, [area, streetsOpen])

  useEffect(() => {
    langRef.current = lang
    saveLang(lang)
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
  }, [lang])

  /** Keeps the globe centred in the free space beside (desktop) or above (phone) the news panel. */
  const pad = (m: maplibregl.Map) => {
    const w = window.innerWidth
    m.setPadding(w > 700 ? { top: 0, bottom: 0, left: langRef.current === 'ar' ? 0 : 440, right: langRef.current === 'ar' ? 440 : 0 } : { top: 0, left: 0, right: 0, bottom: Math.round(window.innerHeight * 0.5) })
  }
  useEffect(() => { if (map.current) pad(map.current) }, [lang])

  /** Zoom at which the whole globe (diameter ~163 * 2^zoom px) fits in the free space beside / above the panel. */
  const startZoom = () => {
    const w = window.innerWidth
    const free = w > 700 ? Math.min(w - 440, window.innerHeight) : Math.min(w, window.innerHeight * 0.5)
    return Math.max(0.5, Math.log2((0.9 * free) / 163))
  }

  useEffect(() => {
    const n = Object.values(unread).reduce((a, b) => a + b, 0)
    document.title = n ? `(${n}) NewzLocal` : 'NewzLocal'
  }, [unread])

  const select = (p: Place) => {
    setOnly(null); setTopic(''); setMonths(0)
    setFreshArts((u) => { const k = label(p); if (!u[k]) return u; const { [k]: _, ...rest } = u; return rest })
    spin.current = false
    setPlace(p); setLevel(0); setHits([]); setSearched(false); setTab((x) => (x === 'favs' ? 'news' : x))
    pin.current?.remove()
    const m = map.current
    if (m) pin.current = new maplibregl.Marker({ color: '#c8321e' }).setLngLat([p.lon, p.lat]).addTo(m)
  }

  const drawPieces = (c: Cur) => {
    const m = map.current
    const src = m?.getSource('areas') as maplibregl.GeoJSONSource | undefined
    const names = m?.getSource('area-names') as maplibregl.GeoJSONSource | undefined
    if (!src || !names) return
    cur.current = c
    hov.current = undefined
    src.setData({
      type: 'FeatureCollection',
      features: c.feats.map((f) => ({ ...f, properties: { ...f.properties, sel: f.properties.name === c.sel ? 1 : 0, n: heat.current[f.properties.name] ?? 0 } })),
    } as never)
    names.setData({
      type: 'FeatureCollection',
      features: [...new Map(c.feats.map((f) => [f.properties.name, f])).values()].map((f) => ({ type: 'Feature', properties: { name: f.properties.name, label: heat.current[f.properties.name] ? `${f.properties.name} · ${heat.current[f.properties.name]}` : f.properties.name }, geometry: { type: 'Point', coordinates: labelPoint(f.geometry) } })),
    } as never)
  }

  /** Splits a district into neighbourhoods (OSM boundaries) or, failing that, named places, and draws them as pieces. */
  const loadSub = async (f: Area, c: Cur) => {
    const me = ++seq.current
    setLoadingAreas(true)
    try {
      let subs = await subAreas(f)
      if (!subs.length) subs = await places(f)
      if (me === seq.current && subs.length) drawPieces({ ...c, mode: 3, feats: subs, sel: undefined, district: f.properties.name })
    } catch { if (me === seq.current) setErr('err.areas') } finally { if (me === seq.current) setLoadingAreas(false) }
  }

  /** Draws the clickable pieces: provinces of a country, or the districts of one province. */
  const showAreas = async (c: Ctx, adm1?: string, selected?: string, pt?: [number, number], withSub = false): Promise<[[number, number], [number, number]] | undefined> => {
    const m = map.current
    if (!m?.getSource('areas')) return
    const me = ++seq.current
    setLoadingAreas(true)
    try {
      const a1 = await boundaries(c.cc, 1)
      let feats = a1?.features ?? []
      let mode: 1 | 2 = 1
      const hit = (pt && at(feats, pt)) || (adm1 && feats.find((f) => norm(f.properties.name) === norm(adm1)))
      if (a1 && hit) {
        const a2 = await boundaries(c.cc, 2).catch(() => null)
        if (a2) {
          link(a1, a2)
          const kids = a2.features.filter((f) => f.properties.parent === hit.properties.name)
          if (kids.length) { feats = kids; mode = 2; selected ??= pt && at(kids, pt)?.properties.name }
        }
      }
      if (me !== seq.current) return // a newer request superseded this one
      drawPieces({ ...c, mode, feats, sel: selected, state: hit ? hit.properties.name : undefined })
      const selArea = mode === 2 && selected ? feats.find((f) => f.properties.name === selected) ?? null : null
      setArea(selArea)
      if (withSub && selArea) loadSub(selArea, cur.current!)
      if (hit) return bounds(hit.geometry)
      return feats.reduce<[[number, number], [number, number]] | undefined>((u, f) => {
        const [[w, s], [e, n]] = bounds(f.geometry)
        return u ? [[Math.min(u[0][0], w), Math.min(u[0][1], s)], [Math.max(u[1][0], e), Math.max(u[1][1], n)]] : [[w, s], [e, n]]
      }, undefined)
    } catch {
      if (me === seq.current) setErr('err.areas')
    } finally {
      if (me === seq.current) setLoadingAreas(false)
    }
  }

  const pick = (p: Place, fly = true) => {
    select(p)
    const m = map.current
    const zoom = { street: 15, district: 13, city: 11, state: 6, country: 4 }[p.parts[0].level]
    if (fly && m) m.flyTo({ center: [p.lon, p.lat], zoom, pitch: zoom > 9 ? 55 : 0, duration: 2500 })
    const country = p.parts[p.parts.length - 1]
    if (p.cc && country.level === 'country')
      showAreas({ cc: p.cc, country: country.name }, p.parts.find((x) => x.level === 'state')?.name, undefined, ['street', 'district', 'city'].includes(p.parts[0].level) ? [p.lon, p.lat] : undefined, p.parts[0].level !== 'street').then((box) => {
        // frame the whole country or province so all its pieces are in view
        const lv = p.parts[0].level
        if (fly && m && box && (lv === 'state' || lv === 'country')) m.fitBounds(box, { padding: 40, pitch: lv === 'state' ? 40 : 0, duration: 2000, maxZoom: 11 })
      })
  }

  const onArea = async (f: Area) => {
    const c = cur.current
    const m = map.current
    if (!c || !m) return
    const [[w, s], [e, n]] = bounds(f.geometry)
    const name = f.properties.name
    const country = { level: 'country' as const, name: c.country }
    const state = { level: 'state' as const, name: c.state ?? f.properties.parent ?? '' }
    const parts =
      c.mode === 1 ? [{ level: 'state' as const, name }, country]
      : c.mode === 2 ? [{ level: 'city' as const, name }, state, country]
      : [{ level: 'district' as const, name }, { level: 'city' as const, name: c.district ?? f.properties.parent ?? '' }, state, country]
    select({ lat: (s + n) / 2, lon: (w + e) / 2, cc: c.cc, parts })
    m.fitBounds([[w, s], [e, n]], { padding: 80, duration: 2200, pitch: c.mode === 1 ? 0 : 50, maxZoom: f.properties.center ? 14 : 13 })
    if (c.mode === 1) { setArea(null); showAreas(c, name); return }
    setArea(f.properties.center ? { ...f, geometry: circle(f.properties.center, 1500) } : f) // a named place without a boundary: its streets are those within 1.5 km
    drawPieces({ ...c, sel: name })
    if (c.mode === 3) return
    loadSub(f, { ...c, sel: name }) // keep drilling down: neighbourhoods or named places inside the district
  }

  const pickStreet = (st: Street) => {
    if (!place) return
    select({ lat: st.lat, lon: st.lon, cc: place.cc, parts: [{ level: 'street', name: st.name }, ...place.parts.filter((p) => p.level !== 'street')] })
    map.current?.flyTo({ center: [st.lon, st.lat], zoom: 16, pitch: 55, duration: 2000 })
  }

  useEffect(() => {
    let m: maplibregl.Map | undefined
    let timer: ReturnType<typeof setInterval>
    let dead = false
    earthStyle().then((style) => {
      if (dead) return
      m = new maplibregl.Map({ container: box.current!, style, center: [25, 35], zoom: startZoom(), maxPitch: 75, attributionControl: { compact: true } })
      map.current = m
      pad(m)
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
      // MapLibre opens the attribution on wide screens; start with just the (i) button
      const closeAttrib = () => {
        const el = m!.getContainer().querySelector('.maplibregl-ctrl-attrib')
        el?.classList.remove('maplibregl-compact-show')
        el?.removeAttribute('open')
      }
      m.once('load', closeAttrib)
      m.once('idle', closeAttrib) // the control re-opens itself while the first tiles arrive
      m.on('style.load', () => {
        m!.setProjection({ type: 'globe' })
        m!.setSky(SKY as never)
        const font = (m!.getStyle().layers.find((l) => l.type === 'symbol')?.layout as { 'text-font'?: string[] } | undefined)?.['text-font']
        m!.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, generateId: true })
        m!.addLayer({
          id: 'areas-fill', type: 'fill', source: 'areas',
          paint: { 'fill-color': '#ff5a3c', 'fill-opacity': ['case', ['==', ['get', 'sel'], 1], 0, ['boolean', ['feature-state', 'hover'], false], 0.3, ['+', 0.05, ['*', 0.05, ['min', ['get', 'n'], 10]]]] },
        })
        m!.addLayer({
          id: 'areas-line', type: 'line', source: 'areas',
          paint: { 'line-color': ['case', ['==', ['get', 'sel'], 1], '#ffd166', '#ffffff'], 'line-width': ['case', ['==', ['get', 'sel'], 1], 3, 1], 'line-opacity': 0.85 },
        })
        m!.addSource('area-names', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        m!.addLayer({
          id: 'areas-label', type: 'symbol', source: 'area-names', minzoom: 3,
          layout: { 'text-field': ['get', 'label'], 'text-size': 13, ...(font ? { 'text-font': font } : {}) },
          paint: { 'text-color': '#fff', 'text-halo-color': '#05070d', 'text-halo-width': 1.6 },
        })
      })
      const unhover = () => {
        if (hov.current !== undefined) m!.setFeatureState({ source: 'areas', id: hov.current }, { hover: false })
        hov.current = undefined
        m!.getCanvas().style.cursor = ''
      }
      m.on('mousemove', 'areas-fill', (e) => {
        const id = e.features?.[0]?.id
        if (id === hov.current) return
        unhover()
        if (id !== undefined) { hov.current = id; m!.setFeatureState({ source: 'areas', id }, { hover: true }); m!.getCanvas().style.cursor = 'pointer' }
      })
      m.on('mouseleave', 'areas-fill', unhover)
      m.on('click', async (e) => {
        const c = cur.current
        const hit = c && m!.getLayer('areas-fill') ? m!.queryRenderedFeatures(e.point, { layers: ['areas-fill'] })[0] : undefined
        if (hit) {
          const f = c!.feats.find((x) => x.properties.name === hit.properties.name && (c!.mode === 1 || x.properties.parent === hit.properties.parent))
          // a click in another area switches area; a click inside the chosen one picks the nearest place or street
          if (f && f.properties.name !== c!.sel) return onArea(f)
        }
        try {
          setErr('')
          if (m!.getZoom() < 5) { // globe click = pick the country
            const c = await reverseCountry(e.lngLat.lat, e.lngLat.lng, langRef.current)
            if (c) pick(c)
            return
          }
          const p = await reverse(e.lngLat.lat, e.lngLat.lng, langRef.current)
          if (p) pick(p, false)
        } catch (x) { setErr((x as Error).message) }
      })
      m.on('mousedown', () => (spin.current = false))
      m.once('load', () => {
        const h = /#p=([^&]+)/.exec(location.hash)?.[1]
        if (!h) return
        try { pick(JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(h)))))) } catch { /* not one of our links */ }
      })
      timer = setInterval(() => spin.current && m!.getZoom() < 3 && m!.easeTo({ center: [m!.getCenter().lng + 12, m!.getCenter().lat], duration: 1000, easing: (n) => n }), 1000)
    }).catch(() => setErr('err.source'))
    return () => { dead = true; clearInterval(timer); m?.remove() }
  }, [])

  useEffect(() => {
    if (!place) return
    let live = true
    const key = `${place.lat},${place.lon},${level},${lang},${tab},${months}`
    const fresh = shown.current !== key // a timed refresh keeps the old list on screen instead of flashing
    shown.current = key
    if (fresh) { setBusy(true); setRes(null) }
    setErr('')
    let ver = 0
    // the forum list arrives in pieces (one per source); only the newest piece is shown, after translating its titles
    const show = async (r: { articles: Article[]; scope: string; query: string }) => {
      const mine = ++ver
      const articles = await translate(r.articles, lang)
      if (live && mine === ver) {
        // a light refresh only looked at the last day, so add it to what is already on screen instead of replacing it
        setRes((prev) => ({ ...r, articles: fresh || !prev || tab === 'forum' ? articles : [...new Map([...prev.articles, ...articles].map((x) => [x.url, x])).values()].sort((x, y) => +y.date - +x.date).slice(0, 100) }))
        setStamp(new Date()); setBusy(false); setOffline(false)
        if (tab === 'news' && months === 0) saveLast(`${label(place)}|${level}|${lang}`, articles)
      }
    }
    const load = tab === 'forum' ? forum(place, level, 100, (r) => r.articles.length && show(r)) : news(place, level, 100, fresh, (r) => r.articles.length && show(r), months)
    load
      .then(show)
      .catch((x) => {
        if (!live) return
        const saved = tab === 'news' && months === 0 ? loadLast(`${label(place)}|${level}|${lang}`) : null
        if (saved?.length) { setRes({ articles: saved, scope: place.parts[level].name, query: '' }); setOffline(true) } else setErr(x.message)
      })
      .finally(() => live && setBusy(false))
    return () => { live = false }
  }, [place, level, lang, tick, tab, months])

  // news heat on the map: how many headlines mention each piece (province, district, neighbourhood ...)
  useEffect(() => {
    const c = cur.current
    if (!c || tab !== 'news' || !res) return
    const heads = res.articles.map((a) => norm(a.orig ?? a.title))
    const next: Record<string, number> = {}
    for (const f of c.feats) {
      const nm = norm(f.properties.name)
      if (nm.length >= 4) { const n = heads.filter((h) => h.includes(nm)).length; if (n) next[f.properties.name] = n }
    }
    if (JSON.stringify(next) !== JSON.stringify(heat.current)) { heat.current = next; drawPieces(c) }
  }, [res, tab])

  // Poll every minute, only while the tab is visible; refresh at once when it becomes visible again.
  useEffect(() => {
    const bump = () => document.visibilityState === 'visible' && setTick((n) => n + 1)
    const id = setInterval(bump, 60_000)
    document.addEventListener('visibilitychange', bump)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', bump) }
  }, [])

  /** From the favourites list: if it has new headlines, show just those (translated), with a button for the whole list. */
  const openFav = (f: Place) => {
    const key = label(f)
    const items = freshArts[key]
    pick(f)
    if (!items?.length) return
    setOnly({ key, items })
    translate(items, langRef.current).then((a) => setOnly((o) => (o && o.key === key ? { key, items: a } : o)))
  }

  const sharePlace = async () => {
    if (!place) return
    const hash = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ lat: place.lat, lon: place.lon, cc: place.cc, parts: place.parts })))))
    const url = `${location.origin}${location.pathname}#p=${hash}`
    try {
      if (navigator.share) await navigator.share({ title: `NewzLocal · ${label(place)}`, url })
      else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    } catch { /* the user closed the share sheet */ }
  }

  /** "My newspaper": the newest headlines of all favourites on one front page. */
  const openMyPaper = async () => {
    if (!favs.length || mineBusy) return
    setMineBusy(true)
    try {
      const lists = await Promise.all(favs.slice(0, 8).map(async (f) => (await news(f, 0, 15, false).catch(() => ({ articles: [] as Article[] }))).articles.map((a) => ({ ...a, source: `${label(f)} · ${a.source}` }))))
      const all = [...new Map(lists.flat().map((a) => [a.url, a])).values()].sort((a, b) => +b.date - +a.date).slice(0, 100)
      setMine(await translate(all, lang))
    } finally { setMineBusy(false) }
  }

  const setAlertTopics = (f: Place, topics: string[]) => {
    const n = favs.map((x) => (label(x) === label(f) ? { ...x, alert: topics.length ? topics : undefined } : x))
    setFavs(n); saveFavs(n)
  }
  const addSource = () => {
    const d = srcDraft.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    if (!d.includes('.') || srcs.includes(d)) return setSrcDraft('')
    const n = [...srcs, d]
    setSrcs(n); saveSources(n); setSrcDraft('')
  }
  const delSource = (d: string) => { const n = srcs.filter((x) => x !== d); setSrcs(n); saveSources(n) }

  const onCrumb = (idx: number) => {
    if (!place) return
    setLevel(idx)
    const part = place.parts[idx]
    const country = place.parts[place.parts.length - 1]
    if (!place.cc) return
    if (part.level === 'country') showAreas({ cc: place.cc, country: country.name })
    else if (part.level === 'state') showAreas({ cc: place.cc, country: country.name }, part.name)
  }

  const doSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    try { setErr(''); const h = await search(q, lang); setHits(h); setSearched(h.length === 0) } catch (x) { setErr((x as Error).message) }
  }
  const onlyNew = !!only && !!place && only.key === label(place) && level === 0 && tab === 'news'
  // ----- favourite categories -----
  const catNames = [...new Set([...cats, ...favs.map((f) => f.cat).filter((c): c is string => !!c)])]
  const commitFavs = (n: Place[]) => { setFavs(n); saveFavs(n) }
  const addCat = (raw: string) => {
    const name = raw.trim().slice(0, 30)
    if (!name) return undefined
    if (!catNames.includes(name)) { const n = [...cats, name]; setCats(n); saveCats(n) }
    return name
  }
  const setCatOf = (f: Place, cat: string) => commitFavs(favs.map((x) => (label(x) === label(f) ? { ...x, cat: cat || undefined } : x)))
  const removeCat = (name: string) => {
    const n = cats.filter((c) => c !== name)
    setCats(n); saveCats(n)
    commitFavs(favs.map((x) => (x.cat === name ? { ...x, cat: undefined } : x)))
    if (favCat === name) setFavCat('')
  }
  /** Pointer-based drag (works with mouse and touch): hold a favourite, move over a category, release. Touch starts from the grip so the list can still scroll. */
  const startDrag = (e: React.PointerEvent, f: Place) => {
    if (e.pointerType === 'mouse' ? e.button !== 0 : !(e.target as HTMLElement).closest('.grip')) return
    const x0 = e.clientX, y0 = e.clientY
    let active = false
    const target = (ev: PointerEvent) => (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]') as HTMLElement | null)?.dataset.drop
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      active = true
      ev.preventDefault()
      setDrag({ name: label(f), x: ev.clientX, y: ev.clientY })
      setOver(target(ev) ?? null)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (active) {
        const cat = target(ev)
        if (cat !== undefined && cat !== (f.cat ?? '')) setCatOf(f, cat)
        justDragged.current = true // the release would otherwise count as a click on the row
        setTimeout(() => { justDragged.current = false }, 0)
      }
      setDrag(null); setOver(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const favRow = (f: Place) => (
    <li key={label(f)} className="favrow" style={{ flexWrap: 'wrap' }} onPointerDown={(e) => startDrag(e, f)}>
      <span className="grip" aria-hidden="true">⠿</span>
      <button onClick={() => !justDragged.current && openFav(f)}>{label(f)}{unread[label(f)] ? <b className="badge">+{unread[label(f)]}</b> : null}</button>
      <button className={cmp.includes(label(f)) ? 'cmp on' : 'cmp'} title={t('compare')} aria-label={t('compare')} onClick={() => setCmp((c) => (c.includes(label(f)) ? c.filter((x) => x !== label(f)) : [...c, label(f)].slice(-2)))}>⇄</button>
      <button className={f.alert?.length || alertOpen === label(f) ? 'bell on' : 'bell'} title={t('alerts')} aria-label={t('alerts')} onClick={() => setAlertOpen((a) => (a === label(f) ? '' : label(f)))}>♪</button>
      <select
        value={f.cat ?? ''}
        aria-label={t('category')}
        onChange={(e) => {
          if (e.target.value !== '__new') return setCatOf(f, e.target.value)
          const name = addCat(window.prompt(t('newCat')) ?? '')
          if (name) setCatOf(f, name)
        }}
      >
        <option value="">{t('noCat')}</option>
        {catNames.map((c) => <option key={c} value={c}>{c}</option>)}
        <option value="__new">＋ {t('newCat')}</option>
      </select>
      {alertOpen === label(f) && (
        <div className="alertbox" onPointerDown={(e) => e.stopPropagation()}>
          <span>{t('alertTopics')}:</span>
          <div className="chips">
            <button className={!f.alert?.length ? 'chip on' : 'chip'} onClick={() => setAlertTopics(f, [])}>{t('alertAll')}</button>
            {TOPICS.map((x) => {
              const on = f.alert?.includes(x.id)
              return <button key={x.id} className={on ? 'chip on' : 'chip'} onClick={() => setAlertTopics(f, on ? f.alert!.filter((y) => y !== x.id) : [...(f.alert ?? []), x.id])}>{t('t' + x.id)}</button>
            })}
          </div>
        </div>
      )}
    </li>
  )

  const isFav = !!place && favs.some((f) => same(f, place))
  // Notify about new headlines in favourites. shortcut: only works while the app/tab is open, true push needs a service worker + server.
  useEffect(() => {
    if (!favs.length) return
    let live = true
    const check = async () => {
      let seen: Record<string, string[]> = {}
      try { seen = JSON.parse(localStorage.getItem('newzlocal.seen') ?? '{}') } catch { /* start over */ }
      for (const f of favs.slice(0, 10)) {
        if (!live) return
        try {
          const key = label(f)
          const { articles } = await news(f, 0, 10, false)
          const old = seen[key]
          const newOnes = old ? articles.filter((a) => !old.includes(a.url)) : [] // first look is only a baseline
          const fresh = f.alert?.length ? newOnes.filter((a) => topicsOf(a.orig ?? a.title).some((id) => f.alert!.includes(id))) : newOnes // per-favourite topic alerts
          seen[key] = [...new Set([...articles.map((a) => a.url), ...(old ?? [])])].slice(0, 200)
          if (fresh.length) setFreshArts((u) => ({ ...u, [key]: [...fresh, ...(u[key] ?? [])].slice(0, 50) }))
          if (fresh.length && 'Notification' in window && Notification.permission === 'granted' && !inQuiet(loadQuiet())) {
            const [first] = await translate([fresh[0]], langRef.current)
            const n = new Notification(key, { body: fresh.length > 1 ? `${first.title} (+${fresh.length - 1})` : first.title, tag: key, renotify: true } as NotificationOptions) // renotify: a repeated tag would otherwise replace the old one silently
            n.onclick = () => { window.focus(); pick(f) }
          }
        } catch { /* try again next round */ }
        await new Promise((x) => setTimeout(x, 2000))
      }
      try { localStorage.setItem('newzlocal.seen', JSON.stringify(seen)) } catch { /* private mode */ }
    }
    check()
    const id = setInterval(check, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [favs])

  const toggleFav = () => {
    if (!place) return
    if (!isFav && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}) // asked once, on the first favourite
    const n = isFav ? favs.filter((f) => !same(f, place)) : [...favs, place]
    setFavs(n); saveFavs(n)
  }

  return (
    <div className="app">
      <div ref={box} className="map" />
      <aside className="panel">
        <header>
          <div className="dateline">
            <span>{new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(new Date())}</span>
            <button className="paperbtn" onClick={() => setPaperOpen(true)} disabled={!res?.articles.length || tab === 'favs'} title={t('paper')} aria-label={t('paper')}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h13v14H6a2 2 0 0 1-2-2V5zM17 8h3v9a2 2 0 0 1-2 2M7 8h7M7 11h7M7 14h4" /></svg>
            </button>
          </div>
          <h1>NewzLocal</h1>
          <div className="langs" role="group" aria-label={t('language')}>
            {LANGS.map((l) => (
              <button key={l.code} className={l.code === lang ? 'on' : ''} title={l.name} aria-label={l.name} aria-pressed={l.code === lang} onClick={() => setLang(l.code)}>
                <img src={`https://flagcdn.com/w40/${l.flag}.png`} alt="" width={24} height={16} />
              </button>
            ))}
          </div>
        </header>
        <form onSubmit={doSearch}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} aria-label={t('searchLabel')} />
        </form>
        {searched && <p className="muted">{t('noResults')}</p>}
        {hits.length > 0 && (
          <ul className="hits">{hits.map((h, i) => <li key={i}><button onClick={() => pick(h)}>{label(h)}</button></li>)}</ul>
        )}
        <nav className="tabs">
          <button className={tab === 'news' ? 'on' : ''} onClick={() => setTab('news')}>{t('news')}</button>
          <button className={tab === 'forum' ? 'on' : ''} onClick={() => setTab('forum')}>{t('forum')}</button>
          <button className={tab === 'favs' ? 'on' : ''} onClick={() => setTab('favs')}>{t('favs')} ({favs.length}){Object.values(unread).reduce((a, b) => a + b, 0) > 0 && <b className="badge">+{Object.values(unread).reduce((a, b) => a + b, 0)}</b>}</button>
        </nav>
        {err && <p className="err">{te(err)}</p>}
        {loadingAreas && <p className="muted">{t('areas')}</p>}
        {tab === 'favs' ? (
          <>
            {perm !== 'granted' && 'Notification' in window && (
              <div className="note">
                {perm === 'denied' ? t('notifyDenied') : t('notifyOff')}{' '}
                {perm !== 'denied' && <button className="linkbtn" onClick={() => Notification.requestPermission().then((p) => { setPerm(p); if (p === 'granted') new Notification('NewzLocal', { body: t('notifyOn') }) })}>{t('notifyEnable')}</button>}
              </div>
            )}
            <div className="chips">
              <button className="chip on" disabled={!favs.length || mineBusy} onClick={openMyPaper}>▤ {mineBusy ? '…' : t('myPaper')}</button>
              {cmp.length === 2 ? <button className="chip on" onClick={() => setCmpOpen(true)}>⇄ {t('compare')}</button> : favs.length > 1 && <span className="muted small">{t('compareHint')}</span>}
            </div>
            <div className="chips">
              <button className={!favCat ? 'chip on' : 'chip'} onClick={() => setFavCat('')}>{t('allCats')} ({favs.length})</button>
              {catNames.map((c) => (
                <span key={c} data-drop={c} className={`${favCat === c ? 'chip on' : 'chip'}${over === c ? ' over' : ''}`}>
                  <button onClick={() => setFavCat(c)}>{c} ({favs.filter((f) => f.cat === c).length})</button>
                  <button className="x" onClick={() => window.confirm(`${t('delCat')}: ${c}?`) && removeCat(c)} aria-label={`${t('delCat')} ${c}`}>×</button>
                </span>
              ))}
              {drag && catNames.length > 0 && <span data-drop="" className={`chip add${over === '' ? ' over' : ''}`}>{t('noCat')}</span>}
              {newCat === null ? (
                <button className="chip add" onClick={() => setNewCat('')}>＋ {t('newCat')}</button>
              ) : (
                <form className="chip" onSubmit={(e) => { e.preventDefault(); const n = addCat(newCat); setNewCat(null); if (n) setFavCat(n) }}>
                  <input autoFocus value={newCat} maxLength={30} placeholder={t('newCat')} aria-label={t('newCat')} onChange={(e) => setNewCat(e.target.value)} onBlur={() => !newCat && setNewCat(null)} />
                </form>
              )}
            </div>
            {favs.length === 0 && <p className="muted">{t('noFavs')}</p>}
            {favCat ? (
              <ul className="hits">{favs.filter((f) => f.cat === favCat).map(favRow)}</ul>
            ) : (
              <>
                {catNames.map((c) => favs.some((f) => f.cat === c) && (
                  <div key={c} data-drop={c} className={over === c ? 'over' : ''}><h4 className="cathead">{c}</h4><ul className="hits">{favs.filter((f) => f.cat === c).map(favRow)}</ul></div>
                ))}
                {favs.some((f) => !f.cat) && (
                  <div {...(catNames.length > 0 ? { 'data-drop': '' } : {})} className={catNames.length > 0 && over === '' ? 'over' : ''}>{catNames.length > 0 && <h4 className="cathead">{t('uncat')}</h4>}<ul className="hits">{favs.filter((f) => !f.cat).map(favRow)}</ul></div>
                )}
              </>
            )}
            <p className="muted small">{t('notifyHint')}</p>
            <div className="settings">
              <h4>{t('quiet')}</h4>
              <div className="row">
                <input type="checkbox" checked={quiet.on} onChange={(e) => { const q = { ...quiet, on: e.target.checked }; setQuiet(q); saveQuiet(q) }} aria-label={t('quiet')} />
                {t('quietFrom')} <input type="time" value={quiet.from} onChange={(e) => { const q = { ...quiet, from: e.target.value }; setQuiet(q); saveQuiet(q) }} />
                {t('quietTo')} <input type="time" value={quiet.to} onChange={(e) => { const q = { ...quiet, to: e.target.value }; setQuiet(q); saveQuiet(q) }} />
              </div>
              <h4>{t('mySources')}</h4>
              <div className="row">
                {srcs.map((d) => <span key={d} className="srcchip"><span style={{ padding: '2px 6px' }}>{d}</span><button onClick={() => delSource(d)} aria-label={`${t('removeSource')} ${d}`}>×</button></span>)}
              </div>
              <form className="row" onSubmit={(e) => { e.preventDefault(); addSource() }}>
                <input value={srcDraft} onChange={(e) => setSrcDraft(e.target.value)} placeholder={t('addSource')} aria-label={t('addSource')} />
              </form>
            </div>
          </>
        ) : !place ? (
          <p className="muted">{t('hint')}</p>
        ) : (
          <>
            <div className="crumbs">
              {[...place.parts].reverse().map((p, i, a) => {
                const idx = a.length - 1 - i
                return <button key={p.name} className={idx === level ? 'c on' : 'c'} onClick={() => onCrumb(idx)}>{p.name}</button>
              })}
              <button className="fav share" onClick={sharePlace} aria-label={t('share')} title={copied ? t('copied') : t('share')}>{copied ? '✓' : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6" /></svg>}</button>
              <button className="fav" onClick={toggleFav} aria-label={t('favorite')}><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z" /></svg></button>
            </div>
            {area && (
              <details className="streets" open={streetsOpen} onToggle={(e) => setStreetsOpen(e.currentTarget.open)}>
                <summary>{t('streets')}{streetList ? ` (${streetList.length})` : ''}</summary>
                {loadingStreets && <p className="muted">{t('loadingStreets')}</p>}
                {streetList && (
                  <>
                    <input value={sf} onChange={(e) => setSf(e.target.value)} placeholder={t('streetFilter')} aria-label={t('streetFilter')} />
                    <ul className="hits">
                      {streetList.filter((x) => norm(x.name).includes(norm(sf))).slice(0, 100).map((x) => <li key={x.name}><button onClick={() => pickStreet(x)}>{x.name}</button></li>)}
                    </ul>
                  </>
                )}
              </details>
            )}
            {tab === 'news' && <TimeTravel months={months} setMonths={setMonths} t={t} />}
            {months > 0 && <p className="note">{t('archiveNote', { when: t(months === 1 ? 't1m' : months === 3 ? 't3m' : months === 6 ? 't6m' : 't1y').toLowerCase() })}</p>}
            {offline && <p className="offline">{t('offline')}</p>}
            {busy && <p className="muted">{t('loading')}</p>}
            {stamp && !busy && <p className="live">{t('updated', { time: stamp.toLocaleTimeString(lang, { timeStyle: 'short' }) })} · {res?.articles.length ?? 0}</p>}
            {onlyNew && <p className="note">{t('newOnly', { n: String(only!.items.length) })} <button className="linkbtn" onClick={() => setOnly(null)}>{t('showAll')}</button></p>}
            {!onlyNew && res && res.articles.length === 0 && <p className="muted">{t(tab === 'forum' ? 'noForum' : 'none')}</p>}
            {tab === 'news' && res && !onlyNew && <TopicBar articles={res.articles.map((a) => ({ ...a, title: a.orig ?? a.title }))} topic={topic} setTopic={setTopic} t={t} />}
            {tab === 'news' && res && !onlyNew && months === 0 && (
              <Report articles={res.articles} scope={res.scope} areas={Object.entries(heat.current).map(([name, n]) => ({ name, n }))} t={t} />
            )}
            <ol className="news">
              {(onlyNew ? only!.items : res?.articles)?.filter((a) => !topic || tab !== 'news' || topicsOf(a.orig ?? a.title).includes(topic)).map((a, i) => (
                <li key={a.url} style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
                  <b className="no">{String(i + 1).padStart(2, '0')}</b>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.orig !== a.title ? a.orig : undefined}>{a.title}</a>
                  <small>{a.forum ? '◆ ' : ''}{a.source} · {a.approx ? '≈ ' : ''}{ago(a.date, lang)}</small>
                </li>
              ))}
            </ol>
          </>
        )}
        <footer>{t('footer')}</footer>
      </aside>
      {drag && <div className="ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>{drag.name}</div>}
      {cmpOpen && cmp.length === 2 && <Compare places={favs.filter((f) => cmp.includes(label(f)))} t={t} onClose={() => setCmpOpen(false)} />}
      {mine && (
        <Paper
          articles={mine}
          place={t('myPaperPlace')}
          date={new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(new Date())}
          pageWord={t('page')}
          tabName={t('myPaper')}
          ago={(d) => ago(d, lang)}
          onClose={() => setMine(null)}
        />
      )}
      {paperOpen && res && (
        <Paper
          articles={res.articles}
          place={place ? label(place) : ''}
          date={new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(new Date())}
          pageWord={t('page')}
          tabName={t(tab === 'forum' ? 'forum' : 'news')}
          ago={(d) => ago(d, lang)}
          onClose={() => setPaperOpen(false)}
        />
      )}
    </div>
  )
}

