/** Local ENU projection + ribbon meshes for Nanasa 4-lane + median corridor. */

const R = 6378137
const DEG = Math.PI / 180

export const ROAD_SPEC = {
  laneWidthM: 3.4,
  lanesIncreasing: 2,
  lanesDecreasing: 2,
  medianWidthM: 4,
}

/** Convert one lng/lat into local meters using a fixed origin. */
export function lngLatToLocal(lng, lat, origin) {
  const cosLat = Math.cos(origin.lat * DEG)
  return {
    x: (lng - origin.lng) * DEG * R * cosLat,
    z: -((lat - origin.lat) * DEG * R),
    lng,
    lat,
  }
}

/** [lng, lat][] → local meters {x east, z south-ish as -north for Three Y-up} */
export function projectToLocal(coords, originOverride = null) {
  if (!coords?.length) return { points: [], origin: null }
  const origin = originOverride || { lng: coords[0][0], lat: coords[0][1] }
  const points = coords.map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
  return { points, origin }
}

function normals2d(pts) {
  const n = pts.length
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz) || 1
    out[i] = { x: -dz / len, z: dx / len }
  }
  return out
}

/** Build a flat ribbon between leftOffset and rightOffset (m) along centerline. */
export function buildRibbonGeometry(points, leftM, rightM, y = 0.05) {
  const n = points.length
  if (n < 2) return null
  const nors = normals2d(points)
  const positions = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  let dist = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) dist += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)
    const p = points[i]
    const nor = nors[i]
    const iL = i * 2
    const iR = i * 2 + 1
    positions[iL * 3] = p.x + nor.x * leftM
    positions[iL * 3 + 1] = y
    positions[iL * 3 + 2] = p.z + nor.z * leftM
    positions[iR * 3] = p.x + nor.x * rightM
    positions[iR * 3 + 1] = y
    positions[iR * 3 + 2] = p.z + nor.z * rightM
    uvs[iL * 2] = 0
    uvs[iL * 2 + 1] = dist * 0.05
    uvs[iR * 2] = 1
    uvs[iR * 2 + 1] = dist * 0.05
  }
  const indices = new Uint32Array((n - 1) * 6)
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3
    const o = i * 6
    indices[o] = a
    indices[o + 1] = c
    indices[o + 2] = b
    indices[o + 3] = b
    indices[o + 4] = c
    indices[o + 5] = d
  }
  return { positions, uvs, indices }
}

/** Dash segments along a ribbon, interpolated in metres so sparse polylines still dash. */
export function buildDashedRibbon(points, leftM, rightM, y = 0.06, dashLen = 4, gapLen = 6) {
  if (!points?.length || points.length < 2) return []
  const geos = []
  let isDash = true
  let remain = dashLen
  let buf = [{ x: points[0].x, z: points[0].z }]

  const flushDash = () => {
    if (buf.length >= 2) {
      const g = buildRibbonGeometry(buf, leftM, rightM, y)
      if (g) geos.push(g)
    }
    buf = []
  }

  for (let i = 1; i < points.length; i++) {
    let x0 = points[i - 1].x
    let z0 = points[i - 1].z
    const x1 = points[i].x
    const z1 = points[i].z
    let dx = x1 - x0
    let dz = z1 - z0
    let seg = Math.hypot(dx, dz)
    while (seg > 1e-4) {
      const take = Math.min(seg, remain)
      const t = take / seg
      x0 += dx * t
      z0 += dz * t
      if (isDash) buf.push({ x: x0, z: z0 })
      remain -= take
      dx = x1 - x0
      dz = z1 - z0
      seg = Math.hypot(dx, dz)
      if (remain <= 1e-4) {
        if (isDash) flushDash()
        isDash = !isDash
        remain = isDash ? dashLen : gapLen
        if (isDash) buf = [{ x: x0, z: z0 }]
      }
    }
  }
  if (isDash) flushDash()
  return geos
}

/** Offset a polyline in local meters, return [lat, lng][] for Leaflet. */
export function offsetLatLngs(coords, offsetM) {
  const { points } = projectToLocal(coords)
  if (points.length < 2) return []
  const nors = normals2d(points)
  const [oLng, oLat] = coords[0]
  const cosLat = Math.cos(oLat * DEG)
  return points.map((p, i) => {
    const nor = nors[i]
    const x = p.x + nor.x * offsetM
    const z = p.z + nor.z * offsetM
    const lat = oLat - (z / R) / DEG
    const lng = oLng + (x / (R * cosLat)) / DEG
    return [lat, lng]
  })
}

/** Build Leaflet polygon rings for each carriageway + median. */
export function buildCorridorPolygons(coords, spec = ROAD_SPEC) {
  const halfMed = spec.medianWidthM / 2
  const carriage = spec.laneWidthM * spec.lanesIncreasing
  const leftOuter = -(halfMed + carriage)
  const leftInner = -halfMed
  const rightInner = halfMed
  const rightOuter = halfMed + carriage

  const leftOut = offsetLatLngs(coords, leftOuter)
  const leftIn = offsetLatLngs(coords, leftInner)
  const rightIn = offsetLatLngs(coords, rightInner)
  const rightOut = offsetLatLngs(coords, rightOuter)

  const ring = (a, b) => [...a, ...[...b].reverse()]

  return {
    increasing: ring(leftOut, leftIn),
    median: ring(leftIn, rightIn),
    decreasing: ring(rightIn, rightOut),
    centerline: coords.map(([lng, lat]) => [lat, lng]),
    edges: {
      leftOuter: leftOut,
      rightOuter: rightOut,
    },
  }
}

/** Cumulative arc length (m) along centerline polyline. */
export function polylineMetrics(points) {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z))
  }
  return { cumDist: cum, totalM: cum[cum.length - 1] || 0 }
}

/** Sample position + tangent + left normal at distance `distM` along polyline. */
export function sampleAtDistance(points, distM) {
  const { cumDist, totalM } = polylineMetrics(points)
  const d = Math.max(0, Math.min(distM, totalM))
  let i = 1
  while (i < cumDist.length && cumDist[i] < d) i++
  const i0 = Math.max(0, i - 1)
  const i1 = Math.min(points.length - 1, i)
  const seg = cumDist[i1] - cumDist[i0] || 1
  const t = (d - cumDist[i0]) / seg
  const a = points[i0]
  const b = points[i1]
  const x = a.x + (b.x - a.x) * t
  const z = a.z + (b.z - a.z) * t
  const tx = b.x - a.x
  const tz = b.z - a.z
  const tLen = Math.hypot(tx, tz) || 1
  const nx = -tz / tLen
  const nz = tx / tLen
  return { x, z, nx, nz, tx: tx / tLen, tz: tz / tLen }
}

/**
 * Map chainage (km) to corridor point.
 * Facing increasing chainage: left (−normal) = Increasing / LHS, right (+normal) = Decreasing / RHS.
 * Travel facing: LHS & Increasing look start→end; RHS & Decreasing look end→start.
 */
export function sampleChainageShoulder(points, chainageKm, minKm, maxKm, side, shoulderM) {
  const span = maxKm - minKm || 1
  const { totalM } = polylineMetrics(points)
  const distM = ((chainageKm - minKm) / span) * totalM
  const s = sampleAtDistance(points, distM)
  const mode = String(side || 'median').toLowerCase()
  // Side offset (left/right when looking along increasing)
  let sign = 0
  if (mode === 'lhs' || mode === 'inc' || mode === 'increasing') sign = -1
  else if (mode === 'rhs' || mode === 'dec' || mode === 'decreasing') sign = 1
  // Travel facing along the selected path
  const reverse = mode === 'rhs' || mode === 'dec' || mode === 'decreasing'
  const yaw = reverse
    ? Math.atan2(-s.tx, -s.tz)
    : Math.atan2(s.tx, s.tz)
  return {
    x: s.x + s.nx * shoulderM * sign,
    z: s.z + s.nz * shoulderM * sign,
    yaw,
    chainageKm,
    tx: reverse ? -s.tx : s.tx,
    tz: reverse ? -s.tz : s.tz,
  }
}

export function laneBands(spec = ROAD_SPEC) {
  const half = spec.medianWidthM / 2
  const w = spec.laneWidthM
  const dec = []
  const inc = []
  for (let i = 0; i < spec.lanesIncreasing; i++) {
    const outer = -(half + w * (i + 1))
    const inner = -(half + w * i)
    inc.push({ left: outer, right: inner, label: `Inc L${i + 1}` })
  }
  for (let i = 0; i < spec.lanesDecreasing; i++) {
    const inner = half + w * i
    const outer = half + w * (i + 1)
    dec.push({ left: inner, right: outer, label: `Dec L${i + 1}` })
  }
  return {
    median: { left: -half, right: half, label: 'Median' },
    decreasing: dec,
    increasing: inc,
  }
}

/**
 * Snap a map click/drop to the nearest median vertex and return chainage + carriageway side.
 * +normal = RHS / Decreasing, −normal = LHS / Increasing.
 * Returns null if farther than `maxDistM` from the corridor.
 */
export function snapLatLngToRoad(lat, lng, coords, minKm, maxKm, maxDistM = 150) {
  if (lat == null || lng == null || !coords?.length) return null
  const { points, origin } = projectToLocal(coords)
  if (!points.length || !origin) return null
  const loc = lngLatToLocal(lng, lat, origin)
  const { cumDist, totalM } = polylineMetrics(points)
  if (!totalM) return null

  let bestI = 0
  let bestD = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - loc.x, points[i].z - loc.z)
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }
  if (bestD > maxDistM) return null

  const s = sampleAtDistance(points, cumDist[bestI])
  const sideDot = (loc.x - s.x) * s.nx + (loc.z - s.z) * s.nz
  const pathMode = Math.abs(sideDot) < 1.2 ? 'median' : sideDot >= 0 ? 'rhs' : 'lhs'
  const span = maxKm - minKm || 1
  const chainageKm = minKm + (cumDist[bestI] / totalM) * span
  return {
    chainageKm: Math.max(minKm, Math.min(maxKm, chainageKm)),
    pathMode,
    distM: bestD,
    lat: points[bestI].lat,
    lng: points[bestI].lng,
  }
}

/** Scrubber t (0..1) for a chainage on a given path mode. */
export function scrubTFromChainage(chainageKm, pathMode, minKm, maxKm) {
  const span = maxKm - minKm || 1
  const km = Math.max(minKm, Math.min(maxKm, Number(chainageKm) || minKm))
  if (pathMode === 'rhs') return Math.max(0, Math.min(1, (maxKm - km) / span))
  return Math.max(0, Math.min(1, (km - minKm) / span))
}
