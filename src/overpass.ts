// Levels below the country datasets (neighbourhoods, streets) come straight from OpenStreetMap via Overpass,
// so any district in the world can be drilled into, as far as OSM has the data.
import { type Area, at, bounds, labelPoint } from './areas'

type Pos = [number, number]
const EP = 'https://overpass-api.de/api/interpreter'

const cache = new Map<string, unknown>()

/** The public Overpass server can take 30+ s, so answers are cached and a request gives up after 70 s. */
async function run(ql: string) {
  if (cache.has(ql)) return cache.get(ql) as { elements: unknown[] }
  const r = await fetch(EP, { method: 'POST', body: `data=${encodeURIComponent(ql)}`, signal: AbortSignal.timeout(70_000) })
  if (!r.ok) throw new Error('err.areas')
  const j = await r.json()
  cache.set(ql, j)
  return j
}

const eq = (a: Pos, b: Pos) => a[0] === b[0] && a[1] === b[1]

/** Joins the ways of a boundary relation end to end into closed rings. */
function rings(ways: Pos[][]): Pos[][] {
  const pool = ways.filter((w) => w.length > 1)
  const out: Pos[][] = []
  while (pool.length) {
    let ring = pool.pop()!
    for (let grew = true; grew && !eq(ring[0], ring[ring.length - 1]); ) {
      grew = false
      const end = ring[ring.length - 1]
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i]
        if (eq(w[0], end)) ring = ring.concat(w.slice(1))
        else if (eq(w[w.length - 1], end)) ring = ring.concat(w.slice(0, -1).reverse())
        else continue
        pool.splice(i, 1)
        grew = true
        break
      }
    }
    if (ring.length > 3 && eq(ring[0], ring[ring.length - 1])) out.push(ring)
  }
  return out
}

type Rel = { tags?: Record<string, string>; members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[] }

/** Smaller administrative areas (neighbourhoods, villages) inside `parent`, or [] when OSM has none. */
export async function subAreas(parent: Area): Promise<Area[]> {
  const [[w, s], [e, n]] = bounds(parent.geometry)
  const j = await run(`[out:json][timeout:30];rel["boundary"="administrative"]["admin_level"~"^(7|8|9|10|11)$"](${s},${w},${n},${e});out geom;`)
  const byLevel = new Map<number, Area[]>()
  for (const rel of j.elements as Rel[]) {
    const name = rel.tags?.name
    if (!name || name === parent.properties.name) continue
    const rs = rings((rel.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry!.map((p) => [p.lon, p.lat] as Pos)))
    if (!rs.length) continue
    const a: Area = { type: 'Feature', properties: { name, parent: parent.properties.name }, geometry: { type: 'MultiPolygon', coordinates: rs.map((r) => [r]) } }
    if (!at([parent], labelPoint(a.geometry))) continue // bbox neighbours that are not inside this district
    const lv = Number(rel.tags!.admin_level)
    byLevel.set(lv, [...(byLevel.get(lv) ?? []), a])
  }
  // the coarsest level that actually splits the district into several pieces
  const level = [...byLevel.keys()].sort((a, b) => a - b).find((k) => byLevel.get(k)!.length >= 2)
  return level === undefined ? [] : byLevel.get(level)!
}

/** A circle as a polygon, so a named place without an OSM boundary can be drawn, clicked and searched like an area. */
export function circle(c: Pos, metres: number, n = 32): Area['geometry'] {
  const dLat = metres / 111320
  const dLon = dLat / Math.cos((c[1] * Math.PI) / 180)
  const ring = Array.from({ length: n + 1 }, (_, i) => {
    const a = ((i % n) / n) * 2 * Math.PI
    return [c[0] + dLon * Math.cos(a), c[1] + dLat * Math.sin(a)] as Pos
  })
  return { type: 'Polygon', coordinates: [ring] }
}

/**
 * Named places (suburbs, neighbourhoods, villages) inside `parent`. Most countries have no boundary polygons for
 * these, so each is a small circle around its point; picking one lists the streets within 1.5 km of it.
 */
export async function places(parent: Area): Promise<Area[]> {
  const [[w, s], [e, n]] = bounds(parent.geometry)
  const j = await run(`[out:json][timeout:30];nwr["place"~"^(suburb|neighbourhood|quarter|borough|village|hamlet|town|locality)$"]["name"](${s},${w},${n},${e});out center;`)
  const seen = new Map<string, Area>()
  for (const el of j.elements as { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: { name: string; place: string } }[]) {
    const c: Pos | undefined = el.lat !== undefined ? [el.lon!, el.lat] : el.center && [el.center.lon, el.center.lat]
    if (!c || seen.has(el.tags.name) || el.tags.name === parent.properties.name || !at([parent], c)) continue
    seen.set(el.tags.name, {
      type: 'Feature',
      properties: { name: el.tags.name, parent: parent.properties.name, center: c },
      geometry: circle(c, el.tags.place === 'hamlet' ? 400 : 600),
    })
  }
  return seen.size >= 2 ? [...seen.values()] : []
}

export type Street = { name: string; lat: number; lon: number }

/** Named streets whose centre lies inside `area`, alphabetical, one entry per name. */
export async function streets(area: Area): Promise<Street[]> {
  const [[w, s], [e, n]] = bounds(area.geometry)
  const j = await run(
    `[out:json][timeout:40];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"]["name"](${s},${w},${n},${e});out tags center;`,
  )
  const seen = new Map<string, Street>()
  for (const el of j.elements as { tags: { name: string }; center?: { lat: number; lon: number } }[]) {
    if (!el.center || seen.has(el.tags.name) || !at([area], [el.center.lon, el.center.lat])) continue
    seen.set(el.tags.name, { name: el.tags.name, lat: el.center.lat, lon: el.center.lon })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
