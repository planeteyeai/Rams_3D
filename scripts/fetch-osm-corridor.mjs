import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const R = 6378137
const DEG = Math.PI / 180
const CORRIDOR_M = 200
const CHUNK_M = 8000
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEDIAN = path.join(ROOT, 'src/assets/data/nanasa-median.json')
const OUT = path.join(ROOT, 'src/assets/data/nanasa-surroundings.json')
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]

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
      ;[0, 90, 180, 270].forEach((bearing, bi) => {
        const p = destination(lng, lat, bearing, CORRIDOR_M)
        minLng = Math.min(minLng, p[0])
        maxLng = Math.max(maxLng, p[0])
        minLat = Math.min(minLat, p[1])
        maxLat = Math.max(maxLat, p[1])
        if (bi < 0) minLng = p[0]
      })
    })
    out.push([minLng, minLat, maxLng, maxLat])
    start = i
  }
  return out
}

async function postQuery(query) {
  let last = ''
  for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': 'nanasa-road-corridor/1.0' },
        body: query,
        signal: AbortSignal.timeout(45000),
      })
      if (res.ok) return res.json()
      last = `${res.status} ${url}`
      const wait = res.status === 429 ? 15000 : 2000
      console.log(`  retry in ${wait / 1000}s (${last})`)
      await sleep(wait)
    } catch (err) {
      last = `${err.cause?.code || err.name || 'error'} ${url}`
      console.log(`  retry (${last})`)
      await sleep(1500)
    }
  }
  throw new Error(last || 'request failed')
}

const median = JSON.parse(fs.readFileSync(MEDIAN, 'utf8'))
const boxes = chunksFor(median.coordinates)
console.log(`chunks ${boxes.length}`)
const seen = new Set()
const features = []
for (let i = 0; i < boxes.length; i++) {
  const [west, south, east, north] = boxes[i]
  const query = `[out:json][timeout:40];(way["building"](${south},${west},${north},${east});node["natural"="tree"](${south},${west},${north},${east});node["man_made"](${south},${west},${north},${east});node["power"="tower"](${south},${west},${north},${east}););out geom;`
  console.log(`chunk ${i + 1}/${boxes.length}`)
  const json = await postQuery(query)
  for (const el of json.elements || []) {
    const id = `${el.type}/${el.id}`
    if (seen.has(id)) continue
    seen.add(id)
    const tags = el.tags || {}
    if (el.type === 'way' && tags.building && el.geometry?.length >= 4) {
      const ring = el.geometry.map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6])
      features.push({ id, kind: 'building', ring, tags: { height: tags.height || '', levels: tags['building:levels'] || '' } })
    } else if (el.type === 'node' && tags.natural === 'tree') {
      features.push({ id, kind: 'tree', at: [el.lon, el.lat], tags: { height: tags.height || '' } })
    } else if (el.type === 'node' && (tags.man_made || tags.power === 'tower')) {
      const made = tags.man_made || 'tower'
      if (made === 'yes' || made === 'survey_point') continue
      features.push({ id, kind: 'structure', at: [el.lon, el.lat], tags: { height: tags.height || '', man_made: made } })
    }
  }
  console.log(`  features ${features.length}`)
  await sleep(2500)
}
fs.writeFileSync(OUT, JSON.stringify({ features }))
console.log(`wrote ${features.length} -> ${OUT}`)
