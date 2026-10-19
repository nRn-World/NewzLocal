// Administrative pieces of a country (provinces → districts) from geoBoundaries (OpenStreetMap-based, open data).
type Pos = [number, number]
export type Area = {
  type: 'Feature'
  properties: { name: string; parent?: string; sel?: number; center?: Pos }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Pos[][] | Pos[][][] }
}
export type Areas = { type: 'FeatureCollection'; features: Area[] }

const ISO3 = Object.fromEntries(
  `ADAND AEARE AFAFG AGATG AIAIA ALALB AMARM AOAGO ARARG ASASM ATAUT AUAUS AWABW AXALA AZAZE BABIH BBBRB BDBGD BEBEL BFBFA BGBGR BHBHR BIBDI BJBEN BMBMU BNBRN BOBOL BRBRA BSBHS BTBTN BWBWA BYBLR BZBLZ CACAN CDCOD CFCAF CGCOG CHCHE CICIV CKCOK CLCHL CMCMR CNCHN COCOL CRCRI CUCUB CVCPV CWCUW CYCYP CZCZE DEDEU DJDJI DKDNK DMDMA DODOM DZDZA ECECU EEEST EGEGY EHESH ERERI ESESP ETETH FIFIN FJFJI FKFLK FMFSM FOFRO FRFRA GAGAB GBGBR GDGRD GEGEO GFGUF GGGGY GHGHA GIGIB GLGRL GMGMB GNGIN GPGLP GQGNQ GRGRC GTGTM GUGUM GWGNB GYGUY HKHKG HNHND HRHRV HTHTI HUHUN IDIDN IEIRL ILISR IMIMN ININD IQIRQ IRIRN ISISL ITITA JEJEY JMJAM JOJOR JPJPN KEKEN KGKGZ KHKHM KIKIR KMCOM KNKNA KPPRK KRKOR KWKWT KYCYM KZKAZ LALAO LBLBN LCLCA LILIE LKLKA LRLBR LSLSO LTLTU LULUX LVLVA LYLBY MAMAR MCMCO MDMDA MEMNE MFMAF MGMDG MHMHL MKMKD MLMLI MMMMR MNMNG MOMAC MPMNP MQMTQ MRMRT MSMSR MTMLT MUMUS MVMDV MWMWI MXMEX MYMYS MZMOZ NANAM NCNCL NENER NFNFK NGNGA NINIC NLNLD NONOR NPNPL NRNRU NUNIU NZNZL OMOMN PAPAN PEPER PFPYF PGPNG PHPHL PKPAK PLPOL PMSPM PRPRI PSPSE PTPRT PWPLW PYPRY QAQAT REREU ROROU RSSRB RURUS RWRWA SASAU SBSLB SCSYC SDSDN SESWE SGSGP SHSHN SISVN SKSVK SLSLE SMSMR SNSEN SOSOM SRSUR SSSSD STSTP SVSLV SXSXM SYSYR SZSWZ TCTCA TDTCD TGTGO THTHA TJTJK TLTLS TMTKM TNTUN TOTON TRTUR TTTTO TVTUV TWTWN TZTZA UAUKR UGUGA USUSA UYURY UZUZB VAVAT VCVCT VEVEN VGVGB VIVIR VNVNM VUVUT WFWLF WSWSM XKXKX YEYEM YTMYT ZAZAF ZMZMB ZWZWE`
    .split(' ').map((s) => [s.slice(0, 2), s.slice(2)]),
)

const cache = new Map<string, Promise<Areas | null>>()

/** adm 1 = provinces/states, 2 = districts. Resolves null when the country has no such level. */
export function boundaries(cc: string, adm: 1 | 2): Promise<Areas | null> {
  const iso = ISO3[cc.toUpperCase()]
  if (!iso) return Promise.resolve(null)
  const key = `${iso}${adm}`
  if (!cache.has(key)) {
    const p = (async () => {
      const meta = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${iso}/ADM${adm}/`)
      if (!meta.ok) return null
      const fc = (await (await fetch(
        // github.com/raw redirects without CORS headers; the LFS media host serves the same file with them
        (await meta.json()).simplifiedGeometryGeoJSON.replace('https://github.com/wmgeolab/geoBoundaries/raw/', 'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/'),
      )).json()) as {
        features: { properties: { shapeName: string }; geometry: Area['geometry'] }[]
      }
      return {
        type: 'FeatureCollection',
        features: fc.features.map((f) => ({ type: 'Feature', properties: { name: f.properties.shapeName }, geometry: f.geometry })),
      } as Areas
    })()
    cache.set(key, p)
    p.catch(() => cache.delete(key)) // allow retry after a network failure
  }
  return cache.get(key)!
}

export const norm = (s: string) =>
  s.toLowerCase().replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(province|il|ili|county|municipality|governorate|region|state|district|city|of)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()

const polys = (g: Area['geometry']) => (g.type === 'Polygon' ? [g.coordinates as Pos[][]] : (g.coordinates as Pos[][][]))

function inRing(p: Pos, ring: Pos[]) {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
const inside = (p: Pos, g: Area['geometry']) => polys(g).some((poly) => inRing(p, poly[0]))

export function bounds(g: Area['geometry']): [[number, number], [number, number]] {
  let w = 180, s = 90, e = -180, n = -90
  for (const poly of polys(g)) for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y) }
  return [[w, s], [e, n]]
}

/** Sets properties.parent on each district by majority vote of sample points on its outline. */
export function link(adm1: Areas, adm2: Areas) {
  const boxes = adm1.features.map((f) => bounds(f.geometry))
  for (const d of adm2.features) {
    if (d.properties.parent) continue
    const ring = polys(d.geometry).reduce((a, b) => (b[0].length > a[0].length ? b : a))[0]
    const step = Math.max(1, Math.floor(ring.length / 15))
    const votes = new Map<string, number>()
    for (let i = 0; i < ring.length; i += step) {
      const pt = ring[i]
      adm1.features.forEach((p, k) => {
        const [[w, s], [e, n]] = boxes[k]
        if (pt[0] >= w && pt[0] <= e && pt[1] >= s && pt[1] <= n && inside(pt, p.geometry))
          votes.set(p.properties.name, (votes.get(p.properties.name) ?? 0) + 1)
      })
    }
    d.properties.parent = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
}

/** One label position per area (centroid of its largest polygon), so the name is drawn once, not once per map tile. */
export function labelPoint(g: Area['geometry']): Pos {
  let best: Pos[] = polys(g)[0][0], bestA = -1, cx = 0, cy = 0
  for (const poly of polys(g)) {
    const r = poly[0]
    let a = 0, x = 0, y = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]
      a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f
    }
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = r; cx = x / (3 * a || 1); cy = y / (3 * a || 1) }
  }
  return bestA > 0 && inRing([cx, cy], best) ? [cx, cy] : best[0] // centroid can fall outside concave shapes
}

/** The area containing a point, so a street or address can be matched to its province and district without comparing names. */
export const at = (feats: Area[], p: Pos) => feats.find((f) => inside(p, f.geometry))
