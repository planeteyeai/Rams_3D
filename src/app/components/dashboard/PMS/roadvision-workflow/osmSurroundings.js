import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { buildRibbonGeometry, lngLatToLocal, mergeRibbonGeometries, polylineMetrics } from './road3dGeometry'
import surroundingsData from '../../../../../assets/data/nanasa-surroundings.json'
import buildingsData from '../../../../../assets/data/nanasa-buildings.json'
import roadsData from '../../../../../assets/data/nanasa-roads.json'
import medianData from '../../../../../assets/data/nanasa-median.json'
import serviceRoadData from '../../../../../assets/data/nanasa-service-roads.json'

const CORRIDOR_M = 200
/** Clear strip for poles / OSM tags that sit close to the kerb. */
const ROAD_CLEAR_M = 12
/** Same clear distance as the MapLibre buildings map — keep footprints off the carriageway. */
const BUILDING_CLEAR_M = 24
const MERGE_CHUNK = 250
const CHAINAGE_MIN_KM = 95
const CHAINAGE_MAX_KM = 142.94
/** Outer edge of the main carriageway plus shoulder, metres from the median. */
const MAIN_OUTER_M = 2 + 3.4 * 2 + 1.7
/** Outer edge of a service road, metres from the median. */
const SERVICE_OUTER_M = MAIN_OUTER_M + 6.5 + 7
const PAVEMENT_GAP_M = 1
const SERVICE_SLIP_KM = 0.08

const SERVICE_SPANS = (serviceRoadData.segments || []).map((seg) => ({
  side: String(seg.dir || '').toLowerCase().startsWith('dec') ? 1 : -1,
  start: Number(seg.start) - SERVICE_SLIP_KM,
  end: Number(seg.end) + SERVICE_SLIP_KM,
}))

function distToSeg(px, pz, a, b) {
  const abx = b.x - a.x
  const abz = b.z - a.z
  const len2 = abx * abx + abz * abz
  if (len2 < 1e-4) return Math.hypot(px - a.x, pz - a.z)
  const t = Math.min(1, Math.max(0, ((px - a.x) * abx + (pz - a.z) * abz) / len2))
  return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t))
}

function distToLine(x, z, pts) {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const d = distToSeg(x, z, pts[i - 1], pts[i])
    if (d < best) best = d
  }
  return best
}

function pavementContext(origin) {
  const line = (medianData.coordinates || []).map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
  return { line, metrics: polylineMetrics(line) }
}

function nearestFrame(p, ctx) {
  const { line, metrics } = ctx
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < line.length; i++) {
    const d = (line[i].x - p.x) ** 2 + (line[i].z - p.z) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  const a = line[Math.max(0, best - 1)]
  const b = line[Math.min(line.length - 1, best + 1)]
  const tx = b.x - a.x
  const tz = b.z - a.z
  const tLen = Math.hypot(tx, tz) || 1
  const nx = -tz / tLen
  const nz = tx / tLen
  const frame = line[best]
  const lateral = (p.x - frame.x) * nx + (p.z - frame.z) * nz
  const side = lateral >= 0 ? 1 : -1
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const km = CHAINAGE_MIN_KM + ((metrics.cumDist[best] || 0) / (metrics.totalM || 1)) * span
  const onService = SERVICE_SPANS.some((seg) => seg.side === side && km >= seg.start && km <= seg.end)
  const pavement = (onService ? SERVICE_OUTER_M : MAIN_OUTER_M) + PAVEMENT_GAP_M
  return { frame, nx, nz, lateral, side, pavement }
}

/** Move a footprint off the main carriageway and off any service road on that side. */
function footprintClear(pts, ctx) {
  const open =
    pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 0.4
      ? pts.slice(0, -1)
      : pts.slice()
  if (open.length < 3) return null
  const info = open.map((p) => ({ p, ...nearestFrame(p, ctx) }))
  const hits = info.filter((row) => Math.abs(row.lateral) < row.pavement)
  if (new Set(info.map((row) => row.side)).size > 1 && hits.length) return null
  if (hits.length > open.length * 0.5) return null
  const moved = info.map((row) => {
    if (Math.abs(row.lateral) >= row.pavement) return row.p
    const off = row.pavement * row.side
    return { x: row.frame.x + row.nx * off, z: row.frame.z + row.nz * off }
  })
  for (let i = 0; i < moved.length; i++) {
    const a = moved[i]
    const b = moved[(i + 1) % moved.length]
    const mid = nearestFrame({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, ctx)
    if (Math.abs(mid.lateral) < mid.pavement - 0.4) return null
  }
  let area = 0
  for (let i = 0; i < moved.length; i++) {
    const a = moved[i]
    const b = moved[(i + 1) % moved.length]
    area += a.x * b.z - b.x * a.z
  }
  return Math.abs(area) < 12 ? null : moved
}

/**
 * Cut a side road where it would run over the carriageway or a service road.
 * The centreline stops far enough out that the road width itself stays clear.
 */
function clipSideRoad(pts, half, ctx) {
  const info = pts.map((p, i) => {
    const placed = nearestFrame(p, ctx)
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz) || 1
    const towardMedian = Math.abs((-dz / len) * placed.nx + (dx / len) * placed.nz)
    const need = placed.pavement + half * towardMedian
    return { x: p.x, z: p.z, lateral: placed.lateral, need }
  })
  const outside = (row) => Math.abs(row.lateral) >= row.need - 0.05
  const boundary = (a, b) => {
    const target = Math.sign(Math.abs(a.lateral) >= a.need ? a.lateral : b.lateral) * (Math.abs(a.lateral) >= a.need ? a.need : b.need)
    const span = b.lateral - a.lateral
    const t = Math.abs(span) < 1e-4 ? 0.5 : (target - a.lateral) / span
    const u = Math.min(1, Math.max(0, t))
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }
  }
  const runs = []
  let cur = []
  const flush = () => {
    if (cur.length >= 2) runs.push(cur)
    cur = []
  }
  for (let i = 0; i < info.length; i++) {
    const row = info[i]
    const prev = info[i - 1]
    if (outside(row)) {
      if (!cur.length && prev && !outside(prev)) cur.push(boundary(prev, row))
      cur.push(row)
    } else if (cur.length) {
      cur.push(boundary(cur[cur.length - 1], row))
      flush()
    }
  }
  flush()
  return runs
}

function parseMeters(raw) {
  if (raw == null || String(raw).trim() === '') return null
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft)?$/i)
  if (!match) return null
  let value = Number(match[1])
  if ((match[2] || '').toLowerCase() === 'ft') value *= 0.3048
  if (!Number.isFinite(value) || value <= 0 || value > 400) return null
  return value
}

function centroid(ring) {
  let lng = 0
  let lat = 0
  const n = Math.max(1, ring.length - 1)
  for (let i = 0; i < n; i++) {
    lng += ring[i][0]
    lat += ring[i][1]
  }
  return [lng / n, lat / n]
}

function structureForm(tag) {
  const kind = String(tag || '')
  if (/chimney/.test(kind)) return 'chimney'
  if (/tower|mast|pole/.test(kind)) return 'pylon'
  if (/tank|silo|water_tower|reservoir/.test(kind)) return 'tank'
  return 'box'
}

function insideCorridor(lng, lat, origin, line, clearM = ROAD_CLEAR_M) {
  const loc = lngLatToLocal(lng, lat, origin)
  const d = distToLine(loc.x, loc.z, line)
  return d >= clearM && d <= CORRIDOR_M
}

/** A tower is kept when it stands inside 200 m, or its span into the next tower crosses that strip. */
function spanEntersCorridor(a, b, line) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) / 30))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (distToLine(a.x + dx * t, a.z + dz * t, line) <= CORRIDOR_M) return true
  }
  return false
}

function pylonsTouchingCorridor(line, origin) {
  const placed = STORED.filter((feature) => feature.kind === 'structure' && feature.form === 'pylon' && feature.at).map((feature) => {
    const loc = lngLatToLocal(feature.at[0], feature.at[1], origin)
    return { feature, loc, keep: distToLine(loc.x, loc.z, line) <= CORRIDOR_M }
  })
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const span = Math.hypot(placed[i].loc.x - placed[j].loc.x, placed[i].loc.z - placed[j].loc.z)
      if (span < 140 || span > 520) continue
      if (!spanEntersCorridor(placed[i].loc, placed[j].loc, line)) continue
      placed[i].keep = true
      placed[j].keep = true
    }
  }
  return placed.filter((pylon) => pylon.keep).map((pylon) => pylon.feature)
}

const STORED = (surroundingsData.features || []).map((row) => {
  const tags = row.tags || {}
  if (row.kind === 'building') {
    const tagged = parseMeters(tags.height)
    const levels = Number(tags.levels)
    let height = tagged
    let estimated = false
    if (height == null && Number.isFinite(levels) && levels > 0 && levels < 80) {
      height = levels * 3
      estimated = true
    }
    if (height == null) {
      height = 4
      estimated = true
    }
    return { id: row.id, kind: 'building', source: 'osm', ring: row.ring, at: centroid(row.ring), height, estimated }
  }
  if (row.kind === 'tree') {
    return { id: row.id, kind: 'tree', at: row.at, height: parseMeters(tags.height) || 6 }
  }
  const made = tags.man_made || 'tower'
  return {
    id: row.id,
    kind: 'structure',
    at: row.at,
    height: parseMeters(tags.height) || (structureForm(made) === 'pylon' ? 34 : 6),
    form: structureForm(made),
  }
})

/** Microsoft / footprint inventory used by the MapLibre tilt map — same set for the road 3D. */
const FOOTPRINT_BUILDINGS = (buildingsData.features || [])
  .map((feature, i) => {
    const ring = feature.geometry?.coordinates?.[0]
    if (!ring?.length) return null
    const height = Number(feature.properties?.height)
    return {
      id: `ms-${i}`,
      kind: 'building',
      source: 'ms',
      ring,
      at: centroid(ring),
      height: Number.isFinite(height) && height > 0 ? Math.min(height, 60) : 5,
      estimated: true,
    }
  })
  .filter(Boolean)

export function loadSurroundings(coords, origin) {
  const line = coords.map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
  const pylons = pylonsTouchingCorridor(line, origin)
  const osm = STORED.filter((feature) => {
    if (!feature.at) return false
    if (feature.kind === 'structure' && feature.form === 'pylon') return false
    const clear = feature.kind === 'building' ? BUILDING_CLEAR_M : ROAD_CLEAR_M
    return insideCorridor(feature.at[0], feature.at[1], origin, line, clear)
  })
  const footprints = FOOTPRINT_BUILDINGS.filter((feature) =>
    insideCorridor(feature.at[0], feature.at[1], origin, line, BUILDING_CLEAR_M),
  )
  return Promise.resolve([...osm, ...footprints, ...pylons])
}

function buildingGeometry(pts, height) {
  if (!pts || pts.length < 3) return null
  const shape = new THREE.Shape()
  shape.moveTo(pts[0].x, -pts[0].z)
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, 0.08, 0)
  return geo
}

function addBuildingMeshes(group, list, origin, color, name) {
  if (!list.length) return 0
  const ctx = pavementContext(origin)
  const geoms = []
  list.forEach((feature) => {
    try {
      const raw = feature.ring.map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
      const geo = buildingGeometry(footprintClear(raw, ctx), feature.height)
      if (geo) geoms.push(geo)
    } catch {
      /* skip a broken footprint */
    }
  })
  if (!geoms.length) return 0
  for (let i = 0; i < geoms.length; i += MERGE_CHUNK) {
    const slice = geoms.slice(i, i + MERGE_CHUNK)
    const merged = slice.length === 1 ? slice[0] : mergeGeometries(slice, false)
    if (slice.length > 1) slice.forEach((geo) => geo.dispose())
    if (!merged) continue
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.92,
        metalness: 0.02,
      }),
    )
    mesh.name = `${name}_${i}`
    group.add(mesh)
  }
  return geoms.length
}

function addBuildings(group, features, origin) {
  const osmTagged = features.filter((f) => f.kind === 'building' && f.source !== 'ms' && !f.estimated)
  const osmEstimated = features.filter((f) => f.kind === 'building' && f.source !== 'ms' && f.estimated)
  const footprints = features.filter((f) => f.kind === 'building' && f.source === 'ms')
  const mid = Math.ceil(footprints.length / 2)
  let n = 0
  n += addBuildingMeshes(group, osmTagged, origin, 0xb7b3ac, 'osmBuildings')
  n += addBuildingMeshes(group, osmEstimated, origin, 0xd7c4a4, 'osmBuildingsEstimated')
  // Muted sand / olive blocks like the MapLibre buildings map.
  n += addBuildingMeshes(group, footprints.slice(0, mid), origin, 0xb8a67a, 'msBuildingsA')
  n += addBuildingMeshes(group, footprints.slice(mid), origin, 0x8f9779, 'msBuildingsB')
  return n
}

function addTrees(group, features, origin) {
  const trees = features.filter((feature) => feature.kind === 'tree')
  if (!trees.length) return 0
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.12, 0.2, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x5a4032, roughness: 0.95 }),
    trees.length,
  )
  const canopy = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.7, 0),
    new THREE.MeshStandardMaterial({ color: 0x2f7a38, roughness: 0.85 }),
    trees.length,
  )
  const dummy = new THREE.Object3D()
  trees.forEach((tree, i) => {
    const loc = lngLatToLocal(tree.at[0], tree.at[1], origin)
    const scale = Math.max(0.6, tree.height / 6)
    dummy.position.set(loc.x, tree.height / 2, loc.z)
    dummy.scale.set(scale, tree.height, scale)
    dummy.rotation.set(0, 0, 0)
    dummy.updateMatrix()
    trunk.setMatrixAt(i, dummy.matrix)
    dummy.position.set(loc.x, tree.height * 0.72, loc.z)
    dummy.scale.set(scale * 1.6, scale * 1.3, scale * 1.6)
    dummy.updateMatrix()
    canopy.setMatrixAt(i, dummy.matrix)
  })
  trunk.instanceMatrix.needsUpdate = true
  canopy.instanceMatrix.needsUpdate = true
  trunk.name = 'osmTreeTrunks'
  canopy.name = 'osmTreeCrowns'
  group.add(trunk)
  group.add(canopy)
  return trees.length
}

const PYLON_H = 34

function steelMember(x0, y0, z0, x1, y1, z1, thick) {
  const dx = x1 - x0
  const dy = y1 - y0
  const dz = z1 - z0
  const len = Math.hypot(dx, dy, dz)
  if (len < 0.05) return null
  const geo = new THREE.BoxGeometry(thick, len, thick)
  geo.translate(0, len / 2, 0)
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  ))
  geo.translate(x0, y0, z0)
  return geo
}

/** Lattice transmission tower, 34 m, crossarms across local X and the line along local Z. */
function pylonGeometry() {
  const parts = []
  const add = (geo) => { if (geo) parts.push(geo) }
  const halfAt = (y) => {
    const t = Math.min(1, Math.max(0, y / 30))
    return 2.55 * (1 - t) + 0.42 * t
  }
  const corner = (y, sx, sz) => [sx * halfAt(y), y, sz * halfAt(y)]
  const signs = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
  signs.forEach(([sx, sz]) => {
    const [x0, y0, z0] = corner(0, sx, sz)
    const [x1, y1, z1] = corner(30, sx, sz)
    add(steelMember(x0, y0, z0, x1, y1, z1, 0.16))
    add(steelMember(x1, y1, z1, 0, 34, 0, 0.08))
    add(steelMember(sx * 0.55, 0, sz * 0.55, x0, 0.15, z0, 0.22))
  })
  ;[7, 14, 21, 28].forEach((y) => {
    for (let i = 0; i < 4; i++) {
      const a = corner(y, signs[i][0], signs[i][1])
      const b = corner(y, signs[(i + 1) % 4][0], signs[(i + 1) % 4][1])
      add(steelMember(a[0], a[1], a[2], b[0], b[1], b[2], 0.1))
    }
  })
  ;[[0, 8], [8, 16], [16, 24]].forEach(([y0, y1]) => {
    for (let i = 0; i < 4; i++) {
      const s0 = signs[i]
      const s1 = signs[(i + 1) % 4]
      const a0 = corner(y0, s0[0], s0[1])
      const b0 = corner(y0, s1[0], s1[1])
      const a1 = corner(y1, s0[0], s0[1])
      const b1 = corner(y1, s1[0], s1[1])
      add(steelMember(a0[0], a0[1], a0[2], b1[0], b1[1], b1[2], 0.07))
      add(steelMember(b0[0], b0[1], b0[2], a1[0], a1[1], a1[2], 0.07))
    }
  })
  const arms = [
    { y: 24.2, half: 4.7, thick: 0.16, drop: 1.35 },
    { y: 28.4, half: 3.8, thick: 0.14, drop: 1.2 },
    { y: 33.1, half: 2.15, thick: 0.1, drop: 0.35 },
  ]
  arms.forEach((arm) => {
    add(steelMember(-arm.half, arm.y, 0, arm.half, arm.y, 0, arm.thick))
    ;[-arm.half, arm.half].forEach((x) => {
      add(steelMember(x, arm.y, 0, x, arm.y - arm.drop, 0, 0.06))
    })
  })
  const merged = mergeGeometries(parts, false)
  parts.forEach((geo) => geo.dispose())
  return merged
}

const PYLON_ARMS = [
  { y: 24.2 - 1.35, x: 4.7 },
  { y: 28.4 - 1.2, x: 3.8 },
  { y: 33.1 - 0.35, x: 2.15 },
]

function chainPylons(placed) {
  const n = placed.length
  const nbrs = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(placed[i].loc.x - placed[j].loc.x, placed[i].loc.z - placed[j].loc.z)
      if (d >= 140 && d <= 540) {
        nbrs[i].push({ j, d })
        nbrs[j].push({ j: i, d })
      }
    }
  }
  const bestStep = (from, prev) => {
    const origin = placed[from].loc
    let vx = 0
    let vz = 0
    if (prev != null) {
      vx = origin.x - placed[prev].loc.x
      vz = origin.z - placed[prev].loc.z
    }
    let best = null
    let bestScore = Infinity
    nbrs[from].forEach(({ j, d }) => {
      if (j === prev || placed[j].used) return
      const wx = placed[j].loc.x - origin.x
      const wz = placed[j].loc.z - origin.z
      let align = 1
      if (prev != null) {
        const mag = Math.hypot(vx, vz) * Math.hypot(wx, wz)
        align = mag > 0 ? (vx * wx + vz * wz) / mag : 1
        if (align < 0.8) return
      }
      const score = Math.abs(d - 310) + (1 - align) * 120
      if (score < bestScore) {
        bestScore = score
        best = j
      }
    })
    return best
  }
  const spans = []
  const walk = (prev, start) => {
    let cur = start
    let before = prev
    while (true) {
      const nxt = bestStep(cur, before)
      if (nxt == null) break
      spans.push([cur, nxt])
      placed[nxt].used = true
      before = cur
      cur = nxt
    }
  }
  const order = placed.map((_, i) => i).sort((a, b) => nbrs[a].length - nbrs[b].length)
  order.forEach((seed) => {
    if (placed[seed].used || !nbrs[seed].length) return
    placed[seed].used = true
    const first = bestStep(seed, null)
    if (first == null) return
    spans.push([seed, first])
    placed[first].used = true
    walk(seed, first)
    const second = bestStep(seed, first)
    if (second == null) return
    spans.push([seed, second])
    placed[second].used = true
    walk(seed, second)
  })
  return spans
}

function conductorGeometry(spans, placed) {
  const geos = []
  spans.forEach(([a, b]) => {
    const span = Math.hypot(placed[b].loc.x - placed[a].loc.x, placed[b].loc.z - placed[a].loc.z)
    const sag = Math.min(9, Math.max(2.2, span * 0.028))
    PYLON_ARMS.forEach((arm) => {
      ;[-arm.x, arm.x].forEach((x) => {
        const p0 = armTip(placed[a], x, arm.y)
        const p1 = armTip(placed[b], x, arm.y)
        const curve = new THREE.CatmullRomCurve3([0, 0.5, 1].map((t) => new THREE.Vector3(
          p0.x + (p1.x - p0.x) * t,
          p0.y + (p1.y - p0.y) * t - sag * Math.sin(Math.PI * t),
          p0.z + (p1.z - p0.z) * t,
        )))
        geos.push(new THREE.TubeGeometry(curve, 4, 0.1, 3, false))
      })
    })
  })
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((geo) => geo.dispose())
  return merged
}

function armTip(pylon, lx, ly) {
  const theta = pylon.theta
  return new THREE.Vector3(
    pylon.loc.x + lx * Math.cos(theta),
    ly * pylon.scaleY,
    pylon.loc.z - lx * Math.sin(theta),
  )
}

function addPylons(group, items, origin) {
  if (!items.length) return 0
  const geo = pylonGeometry()
  if (!geo) return 0
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xb4bcc4, roughness: 0.38, metalness: 0.72 }),
    items.length,
  )
  const dummy = new THREE.Object3D()
  const placed = items.map((item) => {
    const loc = lngLatToLocal(item.at[0], item.at[1], origin)
    const height = Math.max(18, Math.min(item.height || PYLON_H, 80))
    return { item, loc, height, scaleY: height / PYLON_H, theta: 0, used: false }
  })
  const spans = chainPylons(placed)
  const yawOf = new Map()
  spans.forEach(([a, b]) => {
    const dx = placed[b].loc.x - placed[a].loc.x
    const dz = placed[b].loc.z - placed[a].loc.z
    const theta = Math.atan2(dx, dz)
    ;[a, b].forEach((i) => {
      const prev = yawOf.get(i)
      yawOf.set(i, prev == null ? theta : Math.atan2(Math.sin(prev) + Math.sin(theta), Math.cos(prev) + Math.cos(theta)))
    })
  })
  placed.forEach((pylon, i) => {
    let theta = yawOf.get(i)
    if (theta == null) {
      let best = null
      let bestD = Infinity
      placed.forEach((other, j) => {
        if (i === j) return
        const d = Math.hypot(other.loc.x - pylon.loc.x, other.loc.z - pylon.loc.z)
        if (d < bestD) {
          bestD = d
          best = other
        }
      })
      theta = best
        ? Math.atan2(best.loc.x - pylon.loc.x, best.loc.z - pylon.loc.z)
        : 0
    }
    pylon.theta = theta
    dummy.position.set(pylon.loc.x, 0, pylon.loc.z)
    dummy.rotation.set(0, theta, 0)
    dummy.scale.set(1, pylon.scaleY, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.name = 'osmPylons'
  group.add(mesh)
  const wires = conductorGeometry(spans, placed)
  if (wires) {
    const line = new THREE.Mesh(
      wires,
      new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.55, metalness: 0.35 }),
    )
    line.name = 'osmConductors'
    group.add(line)
  }
  return items.length
}

function addStructures(group, features, origin) {
  const items = features.filter((feature) => feature.kind === 'structure')
  if (!items.length) return 0
  const pylons = items.filter((item) => item.form === 'pylon')
  const byForm = { chimney: [], tank: [], box: [] }
  items.forEach((item) => {
    if (item.form === 'pylon') return
    const form = byForm[item.form] ? item.form : 'box'
    byForm[form].push(item)
  })
  const specs = {
    chimney: () => new THREE.CylinderGeometry(0.35, 0.55, 1, 8),
    tank: () => new THREE.CylinderGeometry(1.1, 1.1, 1, 10),
    box: () => new THREE.BoxGeometry(2.2, 1, 2.2),
  }
  const dummy = new THREE.Object3D()
  Object.entries(byForm).forEach(([form, list]) => {
    if (!list.length) return
    const material = new THREE.MeshStandardMaterial({ color: 0x8d93a0, roughness: 0.7, metalness: 0.15 })
    const mesh = new THREE.InstancedMesh(specs[form](), material, list.length)
    list.forEach((item, i) => {
      const loc = lngLatToLocal(item.at[0], item.at[1], origin)
      dummy.position.set(loc.x, item.height / 2, loc.z)
      dummy.scale.set(1, item.height, 1)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.name = `osm${form}`
    group.add(mesh)
  })
  return addPylons(group, pylons, origin) + items.length - pylons.length
}

function ribbonGeometry(raw) {
  if (!raw?.positions?.length) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(raw.positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(raw.uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(raw.indices, 1))
  geo.computeVertexNormals()
  return geo
}

/** Side roads clipped to 200 m, stopping at the outer edge of the main road or service road. */
function addConnectingRoads(group, origin) {
  const roads = roadsData.roads || []
  if (!roads.length) return 0
  const ctx = pavementContext(origin)
  const asphalt = []
  const shoulder = []
  const edge = []
  let kept = 0
  roads.forEach((road) => {
    const pts = (road.pts || []).map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
    if (pts.length < 2) return
    const half = Math.max(1.4, Number(road.w) || 5) / 2
    clipSideRoad(pts, half + 0.55, ctx).forEach((run) => {
      if (run.length < 2) return
      kept += 1
      const surface = buildRibbonGeometry(run, -half, half, 0.08)
      const verge = buildRibbonGeometry(run, -(half + 0.55), half + 0.55, 0.06)
      const left = buildRibbonGeometry(run, -half + 0.02, -half + 0.16, 0.1)
      const right = buildRibbonGeometry(run, half - 0.16, half - 0.02, 0.1)
      if (surface) asphalt.push(surface)
      if (verge) shoulder.push(verge)
      if (left) edge.push(left)
      if (right) edge.push(right)
    })
  })
  const layers = [
    [shoulder, 0x4a453d, 'connectingShoulder'],
    [asphalt, 0x2b2d31, 'connectingRoads'],
    [edge, 0xf2f4f7, 'connectingEdges'],
  ]
  layers.forEach(([parts, color, name]) => {
    const merged = ribbonGeometry(mergeRibbonGeometries(parts))
    if (!merged) return
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        color,
        roughness: name === 'connectingEdges' ? 0.45 : 0.94,
        metalness: 0.02,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    mesh.name = name
    mesh.renderOrder = 3
    group.add(mesh)
  })
  return kept
}

export function createTransmissionGroup(origin) {
  const coords = medianData.coordinates || []
  const line = coords.map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
  const pylons = pylonsTouchingCorridor(line, origin)
  const group = new THREE.Group()
  group.name = 'transmission'
  addPylons(group, pylons, origin)
  return group
}

export function createSurroundingsGroup(features, origin) {
  const group = new THREE.Group()
  group.name = 'osmSurroundings'
  const buildings = addBuildings(group, features, origin)
  const trees = addTrees(group, features, origin)
  const structures = addStructures(group, features, origin)
  const roads = addConnectingRoads(group, origin)
  group.userData.counts = {
    buildings,
    trees,
    structures,
    roads,
  }
  return group
}

export function disposeSurroundings(group) {
  if (!group) return
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose()
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      mats.forEach((mat) => mat.dispose())
    }
  })
}
