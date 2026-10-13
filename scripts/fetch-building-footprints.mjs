/**
 * Keep Microsoft building footprints within 450 m of the Nanasa median.
 * The free file has height -1, so block height is estimated from footprint area.
 */
import { createReadStream, createWriteStream, readFileSync } from 'fs'
import { createGunzip } from 'zlib'
import readline from 'readline'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const median = JSON.parse(readFileSync(join(root, 'src/assets/data/nanasa-median.json'), 'utf8'))
const coords = median.coordinates
const R = 6378137
const BUFFER_M = 450
const origin = coords[0]

function toLocal(lng, lat) {
  const cos = Math.cos((origin[1] * Math.PI) / 180)
  return [(lng - origin[0]) * (Math.PI / 180) * R * cos, (lat - origin[1]) * (Math.PI / 180) * R]
}

const segs = []
for (let i = 1; i < coords.length; i++) {
  const a = toLocal(coords[i - 1][0], coords[i - 1][1])
  const b = toLocal(coords[i][0], coords[i][1])
  segs.push([a[0], a[1], b[0], b[1]])
}

const CELL = 500
const grid = new Map()
function cellKey(x, y) {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
}
for (const seg of segs) {
  const minX = Math.min(seg[0], seg[2])
  const maxX = Math.max(seg[0], seg[2])
  const minY = Math.min(seg[1], seg[3])
  const maxY = Math.max(seg[1], seg[3])
  for (let x = minX; x <= maxX + CELL; x += CELL) {
    for (let y = minY; y <= maxY + CELL; y += CELL) {
      const key = cellKey(x, y)
      const list = grid.get(key)
      if (list) list.push(seg)
      else grid.set(key, [seg])
    }
  }
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function nearRoad(lng, lat) {
  const [x, y] = toLocal(lng, lat)
  let best = Infinity
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(`${Math.floor(x / CELL) + dx},${Math.floor(y / CELL) + dy}`)
      if (!list) continue
      for (const seg of list) {
        const d = distToSeg(x, y, seg[0], seg[1], seg[2], seg[3])
        if (d < best) best = d
        if (best <= BUFFER_M) return true
      }
    }
  }
  return best <= BUFFER_M
}

function ringArea(ring) {
  const lat0 = ring[0][1] * (Math.PI / 180)
  const mLng = 111320 * Math.cos(lat0)
  const mLat = 110540
  let a = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * mLng
    const y1 = ring[i][1] * mLat
    const x2 = ring[i + 1][0] * mLng
    const y2 = ring[i + 1][1] * mLat
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

function blockHeight(area) {
  if (area < 45) return 3
  if (area < 100) return 3.8
  if (area < 200) return 5.5
  if (area < 450) return 8
  if (area < 1200) return 12
  return 16
}

const round = (n) => Math.round(n * 1e6) / 1e6

const files = process.argv.slice(2)

const outPath = join(root, 'src/assets/data/nanasa-buildings.json')
const out = createWriteStream(outPath)
out.write('{"type":"FeatureCollection","features":[')
let kept = 0
let seen = 0

for (const file of files) {
  console.log('read', file)
  const gunzip = createGunzip()
  createReadStream(file).pipe(gunzip)
  const rl = readline.createInterface({ input: gunzip })
  for await (const line of rl) {
    if (!line) continue
    seen += 1
    if (seen % 100000 === 0) console.log('seen', seen, 'kept', kept)
    let feature
    try {
      feature = JSON.parse(line)
    } catch {
      continue
    }
    const ring = feature.geometry?.coordinates?.[0]
    if (!ring?.length) continue
    if (Number(feature.properties?.confidence) < 0.6) continue
    let slng = 0
    let slat = 0
    for (const [lng, lat] of ring) {
      slng += lng
      slat += lat
    }
    const lng = slng / ring.length
    const lat = slat / ring.length
    if (lng < 76.74 || lng > 77.1 || lat < 22.34 || lat > 22.69) continue
    if (!nearRoad(lng, lat)) continue
    const area = ringArea(ring)
    if (area < 12 || area > 20000) continue
    const coordinates = ring.map(([x, y]) => [round(x), round(y)])
    const featureOut = {
      type: 'Feature',
      properties: { height: blockHeight(area), area: Math.round(area) },
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    }
    if (kept) out.write(',')
    out.write(JSON.stringify(featureOut))
    kept += 1
  }
  console.log('seen', seen, 'kept', kept)
}

out.write(']}')
out.end()
await new Promise((resolve) => out.on('finish', resolve))
console.log('wrote', kept, 'buildings')
