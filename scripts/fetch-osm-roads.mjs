/**
 * Side roads that meet the Nanasa median, clipped to 200 m.
 * The highway itself and the parallel service roads are left out — those are already modelled.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const R = 6378137
const DEG = Math.PI / 180
const CORRIDOR_M = 200
const INNER_M = 14
const CHUNK_M = 8000
const CELL = 400
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEDIAN = path.join(ROOT, 'src/assets/data/nanasa-median.json')
const OUT = path.join(ROOT, 'src/assets/data/nanasa-roads.json')
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]

const WIDTH = {
  trunk: 9,
  trunk_link: 6,
  primary: 8,
  primary_link: 6,
  secondary: 7,
  secondary_link: 5.5,
  tertiary: 6,
  tertiary_link: 5,
  unclassified: 5,
  residential: 5,
  living_street: 4.5,
  service: 4,
  track: 3.2,
  road: 5,
  motorway_link: 6,
}

const HW = Object.keys(WIDTH).join('|')

function destination(lng, lat, bearingDeg, distanceM) {
  const δ = distanceM / R
  const θ = bearingDeg * DEG
  const φ1 = lat * DEG
  const λ1 = lng * DEG
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  )
  return [((λ2 / DEG + 540) % 360) - 180, φ2 / DEG]
}

function distance(a, b) {
  const φ1 = a[1] * DEG
  const φ2 = b[1] * DEG
  const dφ = (b[1] - a[1]) * DEG
  const dλ = (b[0] - a[0]) * DEG
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function toLocal(lng, lat, origin) {
  const cosLat = Math.cos(origin.lat * DEG)
  return {
    x: (lng - origin.lng) * DEG * R * cosLat,
    z: -((lat - origin.lat) * DEG * R),
    lng,
    lat,
  }
}

function chunksFor(coords) {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]))
  const out = []
  let start = 0
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] - cum[start] < CHUNK_M && i !== coords.length - 1) continue
    const slice = coords.slice(start, i + 1)
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    slice.forEach(([lng, lat]) => {
      ;[0, 90, 180, 270].forEach((bearing) => {
        const p = destination(lng, lat, bearing, CORRIDOR_M + 40)
        minLng = Math.min(minLng, p[0])
        maxLng = Math.max(maxLng, p[0])
        minLat = Math.min(minLat, p[1])
        maxLat = Math.max(maxLat, p[1])
      })
    })
    out.push([minLng, minLat, maxLng, maxLat])
    start = i
  }
  return out
}

function buildIndex(line) {
  const grid = new Map()
  const put = (k, i) => {
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  }
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL)
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL)
    const z0 = Math.floor(Math.min(a.z, b.z) / CELL)
    const z1 = Math.floor(Math.max(a.z, b.z) / CELL)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) put(`${x},${z}`, i)
    }
  }
  return grid
}

function distToSeg(px, pz, a, b) {
  const abx = b.x - a.x
  const abz = b.z - a.z
  const len2 = abx * abx + abz * abz
  if (len2 < 1e-4) return Math.hypot(px - a.x, pz - a.z)
  const t = Math.min(1, Math.max(0, ((px - a.x) * abx + (pz - a.z) * abz) / len2))
  return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t))
}

function distToLine(x, z, line, grid) {
  const cx = Math.floor(x / CELL)
  const cz = Math.floor(z / CELL)
  let best = Infinity
  const seen = new Set()
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cz + dz}`)
      if (!list) continue
      for (const i of list) {
        if (seen.has(i)) continue
        seen.add(i)
        const d = distToSeg(x, z, line[i - 1], line[i])
        if (d < best) best = d
      }
    }
  }
  if (best < CELL) return best
  for (let i = 1; i < line.length; i++) {
    const d = distToSeg(x, z, line[i - 1], line[i])
    if (d < best) best = d
  }
  return best
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}

function lerp(a, b, t) {
  return {
    lng: a.lng + (b.lng - a.lng) * t,
    lat: a.lat + (b.lat - a.lat) * t,
  }
}

function crossAt(a, b, limit) {
  const span = b.d - a.d
  const t = Math.abs(span) < 1e-3 ? 0.5 : (limit - a.d) / span
  const p = lerp(a, b, Math.min(1, Math.max(0, t)))
  p.d = limit
  return p
}

/** Keep the part of a way that sits between the carriageway edge and 200 m. */
function clipWay(samples) {
  const runs = []
  let cur = []
  const flush = () => {
    if (cur.length >= 2) runs.push(cur)
    cur = []
  }
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]
    const prev = samples[i - 1]
    if (p.d <= CORRIDOR_M) {
      if (!cur.length && prev && prev.d > CORRIDOR_M) cur.push(crossAt(prev, p, CORRIDOR_M))
      cur.push(p)
    } else if (cur.length) {
      cur.push(crossAt(cur[cur.length - 1], p, CORRIDOR_M))
      flush()
    }
  }
  flush()

  const trimmed = []
  runs.forEach((run) => {
    let out = []
    const pushRun = () => {
      if (out.length >= 2) trimmed.push(out.map((p) => ({ lng: p.lng, lat: p.lat })))
      out = []
    }
    for (let i = 0; i < run.length; i++) {
      const p = run[i]
      const prev = run[i - 1]
      const d = p.d ?? CORRIDOR_M
      if (d >= INNER_M) {
        if (!out.length && prev && prev.d < INNER_M) out.push(crossAt(prev, p, INNER_M))
        out.push(p)
      } else if (out.length) {
        if (prev && prev.d >= INNER_M) out.push(crossAt(prev, p, INNER_M))
        pushRun()
      }
    }
    pushRun()
  })
  return trimmed
}

function isParallelHighway(samples) {
  const near = samples.filter((p) => p.d <= CORRIDOR_M + 20)
  if (near.length < 2) return false
  let length = 0
  let close = 0
  for (let i = 1; i < near.length; i++) {
    const step = Math.hypot(near[i].x - near[i - 1].x, near[i].z - near[i - 1].z)
    length += step
    if (near[i].d < 28 && near[i - 1].d < 28) close += step
  }
  return length > 120 && close / length > 0.72
}

function simplify(pts) {
  const out = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1]
    if (distance([prev.lng, prev.lat], [pts[i].lng, pts[i].lat]) >= 4) out.push(pts[i])
  }
  const last = pts[pts.length - 1]
  const prev = out[out.length - 1]
  if (distance([prev.lng, prev.lat], [last.lng, last.lat]) >= 1.5) out.push(last)
  else out[out.length - 1] = last
  return out
}

async function postQuery(query) {
  let last = ''
  for (let attempt = 0; attempt < ENDPOINTS.length * 3; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': 'nanasa-road-corridor/1.0' },
        body: query,
        signal: AbortSignal.timeout(60000),
      })
      if (res.ok) return res.json()
      last = `${res.status} ${url}`
      const wait = res.status === 429 ? 20000 : 2500
      console.log(`  retry in ${wait / 1000}s (${last})`)
      await sleep(wait)
    } catch (err) {
      last = `${err.cause?.code || err.name || 'error'} ${url}`
      console.log(`  retry (${last})`)
      await sleep(2000)
    }
  }
  throw new Error(last || 'request failed')
}

const median = JSON.parse(fs.readFileSync(MEDIAN, 'utf8'))
const origin = { lng: median.coordinates[0][0], lat: median.coordinates[0][1] }
const line = median.coordinates.map(([lng, lat]) => toLocal(lng, lat, origin))
const grid = buildIndex(line)
const boxes = chunksFor(median.coordinates)
console.log(`chunks ${boxes.length}`)

const seen = new Set()
const roads = []
for (let i = 0; i < boxes.length; i++) {
  const [west, south, east, north] = boxes[i]
  const query = `[out:json][timeout:50];way["highway"~"^(${HW})$"](${south},${west},${north},${east});out geom;`
  console.log(`chunk ${i + 1}/${boxes.length}`)
  const json = await postQuery(query)
  for (const el of json.elements || []) {
    const id = `${el.type}/${el.id}`
    if (seen.has(id) || !el.geometry || el.geometry.length < 2) continue
    seen.add(id)
    const tags = el.tags || {}
    if (/driveway|parking/.test(String(tags.service || ''))) continue
    const hw = tags.highway
    const samples = el.geometry.map((p) => {
      const loc = toLocal(p.lon, p.lat, origin)
      loc.d = distToLine(loc.x, loc.z, line, grid)
      return loc
    })
    if (!samples.some((p) => p.d <= CORRIDOR_M)) continue
    if (isParallelHighway(samples)) continue
    const width = WIDTH[hw] || 5
    clipWay(samples).forEach((run) => {
      const pts = simplify(run)
      if (pts.length < 2) return
      let len = 0
      for (let k = 1; k < pts.length; k++) len += distance([pts[k - 1].lng, pts[k - 1].lat], [pts[k].lng, pts[k].lat])
      if (len < 12) return
      roads.push({
        w: width,
        pts: pts.map((p) => [round6(p.lng), round6(p.lat)]),
      })
    })
  }
  console.log(`  roads ${roads.length}`)
  await sleep(2500)
}

fs.writeFileSync(OUT, JSON.stringify({ roads }))
console.log(`wrote ${roads.length} -> ${OUT}`)
