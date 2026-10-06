import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import medianData from '../../../../../assets/data/nanasa-median.json'
import reportedData from '../../../../../assets/data/adani-reported.json'
import predictedData from '../../../../../assets/data/adani-predicted.json'
import pmsData from '../../../../../assets/data/adani-pms.json'
import serviceRoadData from '../../../../../assets/data/nanasa-service-roads.json'
import {
  buildDashedRibbon,
  buildRibbonGeometry,
  mergeRibbonGeometries,
  lngLatToLocal,
  polylineMetrics,
  projectToLocal,
  ROAD_SPEC,
  sampleAtDistance,
  sampleChainageShoulder,
} from './road3dGeometry'

const CHAINAGE_MIN_KM = 95
const CHAINAGE_MAX_KM = 142.94
const NANASA_PROJECT = 'ADANI-NANASA (NPRPL)'

function formatSurveyDate(iso) {
  const d = String(iso || '')
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return d || '—'
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = Number(d.slice(5, 7)) - 1
  return `${d.slice(8, 10)} ${months[m] || d.slice(5, 7)} ${d.slice(0, 4)}`
}

const SCRUBBER_SHOULDER_M =
  ROAD_SPEC.medianWidthM / 2 + ROAD_SPEC.laneWidthM * ROAD_SPEC.lanesIncreasing + 0.5
const DISTRESS_LANE_M =
  ROAD_SPEC.medianWidthM / 2 + ROAD_SPEC.laneWidthM

const IRI_COLORS = {
  good: 0x111111,
  fair: 0xfacc15,
  poor: 0xf8fafc,
  na: 0x94a3b8,
}

/** Reported = traffic-light patches; Predicted = cool-tone markers (easy to tell apart when both on). */
const REPORTED_SEV_COLORS = {
  Low: 0x22c55e,
  Medium: 0xfacc15,
  High: 0xef4444,
}
const PREDICTED_SEV_COLORS = {
  Low: 0x38bdf8,
  Medium: 0xa78bfa,
  High: 0xf472b6,
}

function iriCap(pavement) {
  return pavement === 'concrete' ? 2 : 1.8
}

function iriBand(r) {
  const v = Number(r.iri)
  if (!Number.isFinite(v)) return 'na'
  if (v < iriCap(r.pavement)) return 'good'
  if (v <= 2.4) return 'fair'
  return 'poor'
}

function iriBandLabel(band) {
  return band === 'good' ? 'Good' : band === 'fair' ? 'Fair' : band === 'poor' ? 'Poor' : 'N/A'
}

/** Chainage bin of `lengthM` metres: e.g. 10 → [103.27, 103.28), 100 → [103.2, 103.3). */
function chainageWindow(km, lengthM = 10) {
  const lenKm = Math.max(10, Number(lengthM) || 10) / 1000
  const startRaw = Math.floor(Number(km) / lenKm + 1e-9) * lenKm
  const endRaw = startRaw + lenKm
  const decimals = lenKm >= 1 ? 0 : lenKm >= 0.1 ? 1 : 2
  const round = (n) => Math.round(n * 10 ** decimals) / 10 ** decimals
  return { start: round(startRaw), end: round(endRaw), lengthM: Math.round(lenKm * 1000) }
}

function formatWindowKm(n, lengthM) {
  if (lengthM >= 1000) return Number(n).toFixed(0)
  if (lengthM >= 100) return Number(n).toFixed(1)
  return Number(n).toFixed(2)
}

const WINDOW_LENGTH_OPTIONS = [
  { m: 10, label: '10 m' },
  { m: 50, label: '50 m' },
  { m: 100, label: '100 m' },
  { m: 500, label: '500 m' },
  { m: 1000, label: '1 km' },
]

function overlapsKm(a0, a1, b0, b1) {
  return Number(a0) < Number(b1) && Number(a1) > Number(b0)
}

/**
 * Corridor sides as signed offsets from the median normal (+normal = right of
 * increasing chainage): LHS carries Increasing traffic, RHS carries Decreasing.
 */
const SIDE_LHS = -1
const SIDE_RHS = 1

/** Side sign for an inventory / distress `dir` value. */
function dirSideSign(dir, fallback = SIDE_LHS) {
  const d = String(dir || '').toLowerCase()
  if (d.startsWith('inc')) return SIDE_LHS
  if (d.startsWith('dec')) return SIDE_RHS
  return fallback
}

/** Side the selected path travels on (0 = median, i.e. both carriageways). */
function pathModeSideSign(pathMode) {
  if (pathMode === 'lhs') return SIDE_LHS
  if (pathMode === 'rhs') return SIDE_RHS
  return 0
}

/** Which carriageway a lat/lng falls on, for records that carry no `dir`. */
function gpsSideSign(lat, lng, origin, medianPts) {
  if (lat == null || lng == null || !origin || !medianPts?.length) return 0
  const loc = lngLatToLocal(lng, lat, origin)
  const f = nearestMedianFrame(loc, medianPts)
  return (loc.x - f.x) * f.nx + (loc.z - f.z) * f.nz >= 0 ? SIDE_RHS : SIDE_LHS
}

/** Match inventory / distress direction to path mode (LHS=Inc, RHS=Dec). */
function matchesPathDir(direction, pathMode) {
  const want = pathModeSideSign(pathMode)
  if (!want) return true
  const d = String(direction || '').toLowerCase()
  if (d.startsWith('inc')) return want === SIDE_LHS
  if (d.startsWith('dec')) return want === SIDE_RHS
  return false
}

/** Dense frames along median between chainages — uses full-polyline tangents/normals. */
function sliceMedianFrames(points, startKm, endKm, stepM = 2) {
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const { totalM } = polylineMetrics(points)
  const d0 = ((Math.min(startKm, endKm) - CHAINAGE_MIN_KM) / span) * totalM
  const d1 = ((Math.max(startKm, endKm) - CHAINAGE_MIN_KM) / span) * totalM
  const len = Math.max(0, d1 - d0)
  const step = Math.max(1, stepM)
  const out = []
  if (len < 1e-3) {
    const s = sampleAtDistance(points, d0)
    return [{ x: s.x, z: s.z, nx: s.nx, nz: s.nz }]
  }
  for (let d = d0; d < d1 - 1e-4; d += step) {
    const s = sampleAtDistance(points, d)
    out.push({ x: s.x, z: s.z, nx: s.nx, nz: s.nz })
  }
  const end = sampleAtDistance(points, d1)
  const last = out[out.length - 1]
  if (!last || Math.hypot(last.x - end.x, last.z - end.z) > 0.05) {
    out.push({ x: end.x, z: end.z, nx: end.nx, nz: end.nz })
  }
  return out
}

/** Sample median polyline between two chainages (inclusive). */
function sliceMedianByChainage(points, startKm, endKm) {
  return sliceMedianFrames(points, startKm, endKm, 2).map((f) => ({ x: f.x, z: f.z }))
}

/**
 * Ribbon using each frame's road-aligned normal (same as scrubber / shoulder snap).
 * Avoids normals2d() on a sparse slice — that was cutting chords across bends.
 */
function buildRibbonFromFrames(frames, leftM, rightM, y = 0.05) {
  const n = frames?.length || 0
  if (n < 2) return null
  const positions = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  let dist = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) dist += Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z)
    const p = frames[i]
    const nx = p.nx
    const nz = p.nz
    const iL = i * 2
    const iR = i * 2 + 1
    positions[iL * 3] = p.x + nx * leftM
    positions[iL * 3 + 1] = y
    positions[iL * 3 + 2] = p.z + nz * leftM
    positions[iR * 3] = p.x + nx * rightM
    positions[iR * 3 + 1] = y
    positions[iR * 3 + 2] = p.z + nz * rightM
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

/**
 * Paint IRI condition onto each carriageway using PMS segment records.
 * Adjacent same-side / same-band segments are merged to cut draw calls (~960 → ~tens).
 */
function addPavementIri(root, medianPts, origin, records) {
  const layer = new THREE.Group()
  layer.name = 'pavementIri'
  if (!records?.length || !medianPts?.length || !origin) {
    root.add(layer)
    return layer
  }
  const half = ROAD_SPEC.medianWidthM / 2
  const outer = half + ROAD_SPEC.laneWidthM * ROAD_SPEC.lanesIncreasing

  const items = []
  records.forEach((r) => {
    const start = Number(r.start)
    const end = Number(r.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return

    let side
    const d = String(r.direction || '').toLowerCase()
    if (d.startsWith('inc')) side = SIDE_LHS
    else if (d.startsWith('dec')) side = SIDE_RHS
    else {
      let loc
      if (r.from?.[0] != null && r.to?.[0] != null) {
        const lat = (r.from[0] + r.to[0]) / 2
        const lng = (r.from[1] + r.to[1]) / 2
        loc = lngLatToLocal(lng, lat, origin)
      } else if (r.lat != null && r.lng != null) {
        loc = lngLatToLocal(r.lng, r.lat, origin)
      } else return
      const f = nearestMedianFrame(loc, medianPts)
      side = (loc.x - f.x) * f.nx + (loc.z - f.z) * f.nz >= 0 ? SIDE_RHS : SIDE_LHS
    }
    const lane = /^L[12]$/i.test(String(r.lane || '')) ? String(r.lane).toUpperCase() : ''
    items.push({ start, end, side, lane, band: iriBand(r) })
  })

  items.sort(
    (a, b) =>
      a.side - b.side || a.lane.localeCompare(b.lane) || a.band.localeCompare(b.band) || a.start - b.start,
  )
  const runs = []
  items.forEach((it) => {
    const last = runs[runs.length - 1]
    if (
      last &&
      last.side === it.side &&
      last.lane === it.lane &&
      last.band === it.band &&
      it.start <= last.end + 0.05
    ) {
      last.end = Math.max(last.end, it.end)
      return
    }
    runs.push({ ...it })
  })

  const groups = new Map()
  runs.forEach((run) => {
    // L1 is the median-side lane, L2 the outer lane; no lane → whole carriageway
    let inner = half
    let outerEdge = outer
    if (run.lane === 'L1') outerEdge = half + ROAD_SPEC.laneWidthM
    else if (run.lane === 'L2') inner = half + ROAD_SPEC.laneWidthM
    const left = run.side >= 0 ? inner : -outerEdge
    const right = run.side >= 0 ? outerEdge : -inner
    const frames = sliceMedianFrames(medianPts, run.start, run.end, 4)
    const geo = buildRibbonFromFrames(frames, left, right, 0.055)
    if (!geo) return
    const key = `${run.band}|${left}|${right}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(geo)
    else groups.set(key, [geo])
  })

  groups.forEach((geos, key) => {
    const band = key.slice(0, key.indexOf('|'))
    const color = IRI_COLORS[band] || IRI_COLORS.na
    const mesh = makeMesh(mergeRibbonGeometries(geos), color, {
      roughness: 0.88,
      metalness: 0.04,
    })
    if (!mesh) return
    mesh.material.transparent = true
    mesh.material.opacity = band === 'good' ? 0.55 : band === 'fair' ? 0.72 : 0.78
    mesh.material.depthWrite = false
    mesh.material.polygonOffset = true
    mesh.material.polygonOffsetFactor = -1
    mesh.material.polygonOffsetUnits = -1
    mesh.receiveShadow = false
    mesh.renderOrder = 2
    mesh.userData.iriBand = band
    layer.add(mesh)
  })
  root.add(layer)
  return layer
}

function applyPavementFilter(layer, filter, concreteLayer) {
  const mode = filter || 'all'
  const off = mode === 'off'
  // Concrete is the road surface material, not an IRI overlay — always shown
  if (concreteLayer) concreteLayer.visible = true
  if (!layer) return
  if (off) {
    layer.visible = false
    return
  }
  layer.visible = true
  layer.children.forEach((mesh) => {
    const band = mesh.userData?.iriBand
    mesh.visible = mode === 'all' || band === mode
  })
}

function placeDistressRecord(r, origin, medianPts) {
  const loc = lngLatToLocal(r.longitude, r.latitude, origin)
  const sevRaw = r.severity || 'Low'
  const sev = REPORTED_SEV_COLORS[sevRaw] ? sevRaw : 'Low'
  if (!medianPts?.length) {
    return { x: loc.x, z: loc.z, severity: sev, type: r.distress_type || '', yaw: 0, tx: 0, tz: 1 }
  }
  const f = recordFrame(medianPts, r.chainage_start, r.chainage_end, loc)
  const sign = dirSideSign(r.direction)
  return {
    x: f.x + f.nx * DISTRESS_LANE_M * sign,
    z: f.z + f.nz * DISTRESS_LANE_M * sign,
    severity: sev,
    type: r.distress_type || '',
    yaw: Math.atan2(f.tx, f.tz),
    tx: f.tx,
    tz: f.tz,
  }
}

/** Patch size from survey length × width (fallback √area). */
function distressPatchSize(r) {
  let len = Number(r.length)
  let wid = Number(r.width)
  const area = Number(r.area)
  if ((!Number.isFinite(len) || len <= 0) && Number.isFinite(area) && area > 0) {
    len = Math.sqrt(area)
  }
  if ((!Number.isFinite(wid) || wid <= 0) && Number.isFinite(area) && area > 0 && Number.isFinite(len) && len > 0) {
    wid = area / len
  }
  if (!Number.isFinite(len) || len <= 0) len = 1
  if (!Number.isFinite(wid) || wid <= 0) wid = 1
  // Keep tiny patches visible; cap extreme outliers so they stay on carriageway
  return {
    lengthM: Math.max(0.5, Math.min(len, 45)),
    widthM: Math.max(0.4, Math.min(wid, ROAD_SPEC.laneWidthM * 2)),
  }
}

/**
 * Reported = flat patches (length×width, warm severity colors).
 * Predicted = tall diamond markers (cool severity colors) so both layers read clearly together.
 * For patches, each InstancedMesh stores `userData.records` for click picking.
 * Patches sit above pavement IRI/concrete (y ≈ 0.05–0.055) when both layers are on.
 */
function addDistressLayer(root, records, origin, medianPts, name, scale = 1, asPatch = false) {
  const layer = new THREE.Group()
  layer.name = name
  layer.renderOrder = asPatch ? 12 : 14
  const palette = asPatch ? REPORTED_SEV_COLORS : PREDICTED_SEV_COLORS
  const buckets = {
    Low: [],
    Medium: [],
    High: [],
  }
  ;(records || []).forEach((r) => {
    if (r.latitude == null || r.longitude == null) return
    const pl = placeDistressRecord(r, origin, medianPts)
    pl.record = r
    if (asPatch) {
      const size = distressPatchSize(r)
      pl.lengthM = size.lengthM
      pl.widthM = size.widthM
    }
    buckets[pl.severity].push(pl)
  })

  const dummy = new THREE.Object3D()
  // Pavement overlays sit ~0.05–0.055; keep distress clearly above
  const PATCH_BASE_Y = 0.09

  if (asPatch) {
    Object.entries(buckets).forEach(([sev, list]) => {
      if (!list.length) return
      const color = palette[sev]
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: sev === 'High' ? 0.35 : sev === 'Medium' ? 0.22 : 0.12,
        roughness: 0.72,
        metalness: 0.04,
        transparent: true,
        opacity: sev === 'High' ? 0.88 : sev === 'Medium' ? 0.78 : 0.68,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, list.length)
      mesh.renderOrder = 12
      const outline = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({
          color: 0x0f172a,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          depthTest: true,
        }),
        list.length,
      )
      outline.renderOrder = 13
      const pickRecords = []
      list.forEach((p, i) => {
        const h = sev === 'High' ? 0.12 : sev === 'Medium' ? 0.09 : 0.07
        dummy.position.set(p.x, h * 0.5 + PATCH_BASE_Y, p.z)
        dummy.rotation.set(0, p.yaw || 0, 0)
        dummy.scale.set(p.widthM, h, p.lengthM)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        dummy.position.y = PATCH_BASE_Y + h + 0.012
        dummy.scale.set(p.widthM + 0.1, 0.014, p.lengthM + 0.1)
        dummy.updateMatrix()
        outline.setMatrixAt(i, dummy.matrix)
        pickRecords.push(p.record)
      })
      mesh.instanceMatrix.needsUpdate = true
      outline.instanceMatrix.needsUpdate = true
      mesh.userData.severity = sev.toLowerCase()
      mesh.userData.pickable = true
      mesh.userData.records = pickRecords
      outline.userData.severity = sev.toLowerCase()
      outline.userData.pickable = true
      outline.userData.records = pickRecords
      mesh.receiveShadow = true
      layer.add(mesh, outline)
    })
    root.add(layer)
    return layer
  }

  // Predicted: octahedron “pin” — different silhouette from reported rectangles
  const geo = new THREE.OctahedronGeometry(0.55 * scale, 0)
  const ringGeo = new THREE.RingGeometry(0.4 * scale, 0.65 * scale, 12)

  Object.entries(buckets).forEach(([sev, list]) => {
    if (!list.length) return
    const color = palette[sev]
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.15,
    })
    const mesh = new THREE.InstancedMesh(geo, mat, list.length)
    mesh.renderOrder = 14
    const rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      list.length,
    )
    rings.renderOrder = 14
    list.forEach((p, i) => {
      dummy.position.set(p.x, 1.05 * scale, p.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1.35, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      dummy.position.set(p.x, 0.05, p.z)
      dummy.rotation.set(-Math.PI / 2, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      rings.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    rings.instanceMatrix.needsUpdate = true
    mesh.userData.severity = sev.toLowerCase()
    rings.userData.severity = sev.toLowerCase()
    mesh.castShadow = true
    layer.add(mesh, rings)
  })

  root.add(layer)
  return layer
}

function applyDistressFilter(layer, filter) {
  if (!layer) return
  const mode = (filter || 'all').toLowerCase()
  if (mode === 'off') {
    layer.visible = false
    return
  }
  layer.visible = true
  layer.children.forEach((mesh) => {
    const sev = String(mesh.userData?.severity || '').toLowerCase()
    mesh.visible = mode === 'all' || sev === mode
  })
}

function makeScrubberMarker(color, labelMat) {
  const g = new THREE.Group()
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.85, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.04
  g.add(ring)
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x455a64, metalness: 0.5, roughness: 0.4 }),
  )
  pole.position.y = 1.1
  g.add(pole)
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 12, 10),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.35 }),
  )
  head.position.y = 2.35
  g.add(head)
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.04), labelMat)
  flag.position.set(0.55, 2.1, 0)
  g.add(flag)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}

/** Clear highlight children and dispose GPU resources. */
function clearHighlightLayer(layer) {
  if (!layer) return
  while (layer.children.length) {
    const m = layer.children[0]
    layer.remove(m)
    m.geometry?.dispose()
    if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose())
    else m.material?.dispose()
  }
}

function addBasicRibbon(layer, framesOrPoints, left, right, y, color, opacity) {
  const frames = framesOrPoints?.[0]?.nx != null
    ? framesOrPoints
    : null
  const geoData = frames
    ? buildRibbonFromFrames(frames, left, right, y)
    : buildRibbonGeometry(framesOrPoints, left, right, y)
  if (!geoData) return
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(geoData.positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(geoData.uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(geoData.indices, 1))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  mesh.renderOrder = 6
  layer.add(mesh)
}

/**
 * Paint the active 10 m chainage window on the carriageway matching path mode
 * (LHS / RHS / both for Median) — same bin as the info cards.
 */
function updateChainageHighlight(layer, medianPts, winStart, winEnd, mode) {
  clearHighlightLayer(layer)
  if (!layer || !medianPts?.length) return
  const frames = sliceMedianFrames(medianPts, winStart, winEnd, 1)
  if (frames.length < 2) return

  const half = ROAD_SPEC.medianWidthM / 2
  const outer = half + ROAD_SPEC.laneWidthM * ROAD_SPEC.lanesIncreasing
  const color = mode === 'lhs' ? 0x34d399 : mode === 'rhs' ? 0x60a5fa : 0xfbbf24
  // Inset slightly so the patch sits inside the white edge / median kerb
  const inset = 0.22
  const lhsBand = [-(outer - inset), -(half + inset)]
  const rhsBand = [half + inset, outer - inset]
  const bands = mode === 'lhs' ? [lhsBand] : mode === 'rhs' ? [rhsBand] : [lhsBand, rhsBand]

  bands.forEach(([left, right]) => {
    addBasicRibbon(layer, frames, left, right, 0.085, color, 0.5)
    addBasicRibbon(layer, frames, left - 0.06, left + 0.06, 0.1, 0xffffff, 0.9)
    addBasicRibbon(layer, frames, right - 0.06, right + 0.06, 0.1, 0xffffff, 0.9)
  })
}

const ASPHALT = 0x2b2d31
const CONCRETE = 0xd9d6ce
const SHOULDER = 0x4a453d
const MEDIAN_GRASS = 0x3a6b3e
const MEDIAN_SOIL = 0x5c4a32
const MARK_WHITE = 0xf2f4f7
const MARK_YELLOW = 0xf5d76e
const CONCRETE_MARK = 0xe0a100
const KERB = 0xc5cbd3
const NONE = []

function makeMesh(geoData, color, extra = {}) {
  if (!geoData) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(geoData.positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(geoData.uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(geoData.indices, 1))
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: extra.roughness ?? 0.92,
    metalness: extra.metalness ?? 0.05,
    side: THREE.DoubleSide,
    map: extra.map || null,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  return mesh
}

const sharedTextures = new Set()
const surfaceTexCache = {}

function canvasTex(draw, size = 256, repeatX = 1, repeatY = 40) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d'), size)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeatX, repeatY)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  sharedTextures.add(tex)
  return tex
}

function asphaltMap() {
  if (surfaceTexCache.asphalt) return surfaceTexCache.asphalt
  surfaceTexCache.asphalt = canvasTex((ctx, s) => {
    ctx.fillStyle = '#26282c'
    ctx.fillRect(0, 0, s, s)
    for (let i = 0; i < 9000; i++) {
      const n = 28 + Math.random() * 55
      ctx.fillStyle = `rgba(${n},${n + 1},${n + 3},${0.12 + Math.random() * 0.4})`
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2.2, 1 + Math.random() * 2.2)
    }
    ctx.fillStyle = 'rgba(70,72,76,0.08)'
    for (let y = 0; y < s; y += 18) ctx.fillRect(0, y, s, 1)
  }, 256, 2, 90)
  return surfaceTexCache.asphalt
}

function grassMap() {
  if (!surfaceTexCache.grass) {
    surfaceTexCache.grass = canvasTex((ctx, s) => {
      ctx.fillStyle = '#3d6a3a'
      ctx.fillRect(0, 0, s, s)
      for (let i = 0; i < 5000; i++) {
        ctx.fillStyle = `rgba(${40 + Math.random() * 70},${90 + Math.random() * 80},${35 + Math.random() * 40},${0.25})`
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.5, 2 + Math.random() * 3)
      }
    }, 128, 4, 60)
  }
  return surfaceTexCache.grass.clone()
}

function concreteMap() {
  if (surfaceTexCache.concrete) return surfaceTexCache.concrete
  surfaceTexCache.concrete = canvasTex((ctx, s) => {
    // Weathered grey base (one texture tile = one lane width across)
    ctx.fillStyle = '#b9b6ae'
    ctx.fillRect(0, 0, s, s)
    // Large soft tonal patches
    for (let i = 0; i < 40; i++) {
      const n = 160 + Math.random() * 45
      ctx.fillStyle = `rgba(${n},${n - 2},${n - 8},${0.08 + Math.random() * 0.12})`
      ctx.beginPath()
      ctx.ellipse(Math.random() * s, Math.random() * s, 10 + Math.random() * 40, 6 + Math.random() * 30, Math.random() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    // Aggregate speckle
    for (let i = 0; i < 9000; i++) {
      const n = 120 + Math.random() * 100
      ctx.fillStyle = `rgba(${n},${n - 1},${n - 6},${0.12 + Math.random() * 0.3})`
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 1.6, 1 + Math.random() * 1.6)
    }
    // Wheel-path darkening
    ;[0.27, 0.73].forEach((cx) => {
      const g = ctx.createLinearGradient((cx - 0.1) * s, 0, (cx + 0.1) * s, 0)
      g.addColorStop(0, 'rgba(70,68,64,0)')
      g.addColorStop(0.5, 'rgba(70,68,64,0.16)')
      g.addColorStop(1, 'rgba(70,68,64,0)')
      ctx.fillStyle = g
      ctx.fillRect((cx - 0.1) * s, 0, 0.2 * s, s)
    })
    // Oil / water stains
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = `rgba(60,58,55,${0.05 + Math.random() * 0.07})`
      ctx.beginPath()
      ctx.ellipse(Math.random() * s, Math.random() * s, 4 + Math.random() * 10, 8 + Math.random() * 18, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    // Longitudinal joint at lane edge + transverse slab joints (sealant dark line + light chamfer)
    ctx.fillStyle = 'rgba(55,55,52,0.55)'
    ctx.fillRect(0, 0, 1.5, s)
    for (let y = 0; y < s; y += 64) {
      ctx.fillStyle = 'rgba(55,55,52,0.6)'
      ctx.fillRect(0, y, s, 1.5)
      ctx.fillStyle = 'rgba(230,228,222,0.35)'
      ctx.fillRect(0, y + 1.5, s, 1)
    }
    // Hairline cracks
    ctx.strokeStyle = 'rgba(70,68,64,0.35)'
    ctx.lineWidth = 0.7
    for (let i = 0; i < 5; i++) {
      let x = Math.random() * s
      let y = Math.random() * s
      ctx.beginPath()
      ctx.moveTo(x, y)
      for (let k = 0; k < 6; k++) {
        x += (Math.random() - 0.5) * 14
        y += 4 + Math.random() * 8
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }, 256, 2, 40)
  return surfaceTexCache.concrete
}

function addRibbon(root, points, left, right, y, color, extra = {}) {
  const mesh = makeMesh(buildRibbonGeometry(points, left, right, y), color, extra)
  if (mesh) root.add(mesh)
  return mesh
}

function addDashes(root, points, left, right, y, color) {
  const mesh = makeMesh(mergeRibbonGeometries(buildDashedRibbon(points, left, right, y, 4, 6)), color, {
    roughness: 0.38,
    metalness: 0.06,
  })
  if (mesh) root.add(mesh)
}

function addRealisticRoad(root, points) {
  const half = ROAD_SPEC.medianWidthM / 2
  const w = ROAD_SPEC.laneWidthM
  const outer = half + w * 2
  const asphalt = asphaltMap()
  const grass = grassMap()
  const asphaltMat = { map: asphalt, roughness: 0.96, metalness: 0.02 }

  addRibbon(root, points, -180, 180, -0.04, 0x7d9a5f, { map: grass, roughness: 1, metalness: 0 })
  addRibbon(root, points, -(outer + 1.7), -outer, 0.02, SHOULDER, { roughness: 0.98, metalness: 0 })
  addRibbon(root, points, outer, outer + 1.7, 0.02, SHOULDER, { roughness: 0.98, metalness: 0 })
  addRibbon(root, points, -outer, -half, 0.045, ASPHALT, asphaltMat)
  addRibbon(root, points, half, outer, 0.045, ASPHALT, asphaltMat)
  addRibbon(root, points, -half + 0.35, half - 0.35, 0.1, MEDIAN_SOIL, { roughness: 1, metalness: 0 })
  addRibbon(root, points, -half + 0.45, half - 0.45, 0.16, MEDIAN_GRASS, { map: grass, roughness: 0.98, metalness: 0 })
  ;[-half, half].forEach((off) => {
    addRibbon(root, points, off - 0.18, off + 0.18, 0.26, KERB, { roughness: 0.62, metalness: 0.08 })
    addRibbon(root, points, off - 0.22, off + 0.22, 0.12, 0x9aa3ad, { roughness: 0.75, metalness: 0.06 })
  })
  addRibbon(root, points, -outer - 0.08, -outer + 0.08, 0.06, MARK_WHITE, { roughness: 0.4, metalness: 0.06 })
  addRibbon(root, points, outer - 0.08, outer + 0.08, 0.06, MARK_WHITE, { roughness: 0.4, metalness: 0.06 })
  addRibbon(root, points, -(half + 0.12), -(half + 0.02), 0.062, MARK_YELLOW, { roughness: 0.4, metalness: 0.06 })
  addRibbon(root, points, half + 0.02, half + 0.12, 0.062, MARK_YELLOW, { roughness: 0.4, metalness: 0.06 })
  addDashes(root, points, -(half + w) - 0.08, -(half + w) + 0.08, 0.075, MARK_WHITE)
  addDashes(root, points, half + w - 0.08, half + w + 0.08, 0.075, MARK_WHITE)
  return { asphalt, grass }
}

/**
 * Overlay concrete (grey + yellow markings) where PMS `pavement === "concrete"`.
 * Bituminous stretches keep the base asphalt road unchanged.
 * Returns a THREE.Group so the pavement filter can hide the whole layer.
 */
function addConcretePavementSurfaces(root, medianPts, origin, records) {
  const layer = new THREE.Group()
  layer.name = 'pavementConcrete'
  if (!records?.length || !medianPts?.length || !origin) {
    root.add(layer)
    return layer
  }
  const half = ROAD_SPEC.medianWidthM / 2
  const w = ROAD_SPEC.laneWidthM
  const outer = half + w * 2
  const concrete = concreteMap()
  const concMat = { map: concrete, roughness: 0.93, metalness: 0.0 }

  const items = []
  records.forEach((r) => {
    if (String(r.pavement || '').toLowerCase() !== 'concrete') return
    const start = Number(r.start)
    const end = Number(r.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return

    let side
    const dir = String(r.direction || '').toLowerCase()
    if (dir.startsWith('inc')) side = SIDE_LHS
    else if (dir.startsWith('dec')) side = SIDE_RHS
    else {
      let loc
      if (r.from?.[0] != null && r.to?.[0] != null) {
        loc = lngLatToLocal((r.from[1] + r.to[1]) / 2, (r.from[0] + r.to[0]) / 2, origin)
      } else if (r.lat != null && r.lng != null) {
        loc = lngLatToLocal(r.lng, r.lat, origin)
      } else return
      const f = nearestMedianFrame(loc, medianPts)
      side = (loc.x - f.x) * f.nx + (loc.z - f.z) * f.nz >= 0 ? SIDE_RHS : SIDE_LHS
    }
    items.push({ start, end, side })
  })
  if (!items.length) {
    root.add(layer)
    return layer
  }

  items.sort((a, b) => a.side - b.side || a.start - b.start)
  const runs = []
  items.forEach((it) => {
    const last = runs[runs.length - 1]
    if (last && last.side === it.side && it.start <= last.end + 0.05) {
      last.end = Math.max(last.end, it.end)
      return
    }
    runs.push({ ...it })
  })

  runs.forEach((run) => {
    const left = run.side >= 0 ? half : -outer
    const right = run.side >= 0 ? outer : -half
    const frames = sliceMedianFrames(medianPts, run.start, run.end, 2)
    if (frames.length < 2) return

    // Grey concrete carriageway over asphalt
    const slab = makeMesh(buildRibbonFromFrames(frames, left, right, 0.05), CONCRETE, concMat)
    if (slab) {
      slab.renderOrder = 1
      layer.add(slab)
    }

    // Deeper yellow markings (edge + lane centre) so they read on the pale slab
    const edge = run.side >= 0 ? outer : -outer
    const lane = run.side >= 0 ? half + w : -(half + w)
    const pts = frames.map((f) => ({ x: f.x, z: f.z }))
    addRibbon(layer, pts, edge - 0.08, edge + 0.08, 0.065, CONCRETE_MARK, { roughness: 0.4, metalness: 0.06 })
    addRibbon(layer, pts, (run.side >= 0 ? half : -half) + (run.side >= 0 ? 0.02 : -0.12), (run.side >= 0 ? half : -half) + (run.side >= 0 ? 0.12 : -0.02), 0.066, CONCRETE_MARK, { roughness: 0.4, metalness: 0.06 })
    addDashes(layer, pts, lane - 0.08, lane + 0.08, 0.08, CONCRETE_MARK)
  })
  root.add(layer)
  return layer
}

/** Frame at nearest median point. +normal is LEFT when travelling along tangent. */
function nearestMedianFrame(loc, medianPts) {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < medianPts.length; i++) {
    const dx = medianPts[i].x - loc.x
    const dz = medianPts[i].z - loc.z
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  const a = medianPts[Math.max(0, best - 1)]
  const b = medianPts[Math.min(medianPts.length - 1, best + 1)]
  const tx = b.x - a.x
  const tz = b.z - a.z
  const tLen = Math.hypot(tx, tz) || 1
  const ux = tx / tLen
  const uz = tz / tLen
  const nx = -uz
  const nz = ux
  const p = medianPts[best]
  return { x: p.x, z: p.z, nx, nz, tx: ux, tz: uz }
}

const cumCache = new WeakMap()

function cumulativeFor(medianPts) {
  let c = cumCache.get(medianPts)
  if (!c) {
    c = polylineMetrics(medianPts)
    cumCache.set(medianPts, c)
  }
  return c
}

/**
 * Median frame at a chainage (km) — the same chainage→distance mapping the
 * scrubber, the 10 m highlight and the IRI paint use.
 */
function chainageFrame(medianPts, km) {
  const { cumDist, totalM } = cumulativeFor(medianPts)
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const d = Math.max(0, Math.min(((km - CHAINAGE_MIN_KM) / span) * totalM, totalM))
  let lo = 1
  let hi = cumDist.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cumDist[mid] < d) lo = mid + 1
    else hi = mid
  }
  const i1 = Math.max(1, lo)
  const i0 = i1 - 1
  const seg = cumDist[i1] - cumDist[i0] || 1
  const t = (d - cumDist[i0]) / seg
  const a = medianPts[i0]
  const b = medianPts[i1]
  const tx = b.x - a.x
  const tz = b.z - a.z
  const len = Math.hypot(tx, tz) || 1
  return {
    x: a.x + tx * t,
    z: a.z + tz * t,
    nx: -tz / len,
    nz: tx / len,
    tx: tx / len,
    tz: tz / len,
  }
}

/**
 * Longitudinal position for a record: chainage is authoritative (it is what the
 * info cards filter on), GPS is only a fallback when chainage is missing.
 */
function recordFrame(medianPts, startKm, endKm, loc) {
  const s = Number(startKm)
  const e = Number(endKm)
  const km = Number.isFinite(s) && Number.isFinite(e) ? (s + e) / 2 : s
  if (Number.isFinite(km)) return chainageFrame(medianPts, km)
  return nearestMedianFrame(loc, medianPts)
}

const LIGHT_SHOULDER_M =
  ROAD_SPEC.medianWidthM / 2 + ROAD_SPEC.laneWidthM * ROAD_SPEC.lanesIncreasing + 0.5

/** Service-road inventory sits just beyond the service road's outer edge. */
function sideOffsetM(p, mainM) {
  return p?.road === 'service' ? SERVICE_ROAD_CENTRE_M + SERVICE_ROAD_WIDTH_M / 2 + 0.8 : mainM
}

/** Snap GPS to median, then offset by dir: Increasing = LHS, Decreasing = RHS, median = centreline. */
function placeStreetLight(p, origin, medianPts) {
  const loc = lngLatToLocal(p.lng, p.lat, origin)
  if (!medianPts?.length) return { x: loc.x, z: loc.z, yaw: 0, doubleArm: false }
  const f = recordFrame(medianPts, p.start, p.end, loc)
  if (String(p.dir || '').toLowerCase().startsWith('med')) {
    return { x: f.x, z: f.z, yaw: Math.atan2(f.nx, f.nz), doubleArm: true }
  }
  const sign = dirSideSign(p.dir)
  const off = sideOffsetM(p, LIGHT_SHOULDER_M)
  return {
    x: f.x + f.nx * off * sign,
    z: f.z + f.nz * off * sign,
    yaw: Math.atan2(-f.nx * sign, -f.nz * sign),
    doubleArm: false,
  }
}

function streetLightKit(count) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a9199, metalness: 0.78, roughness: 0.22 })
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x2f3540, metalness: 0.7, roughness: 0.28 })
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb7bec6, metalness: 0.04, roughness: 0.86 })
  const housing = new THREE.MeshStandardMaterial({ color: 0x1a1f28, metalness: 0.62, roughness: 0.32 })
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xfff6d2,
    emissive: 0xffcc66,
    emissiveIntensity: 1.6,
    metalness: 0.04,
    roughness: 0.28,
  })

  const poleH = 8.4
  const armLen = 2.55
  const armY = poleH - 0.08
  const armTilt = 0.14
  const tipY = armY - Math.sin(armTilt) * armLen
  const tipZ = Math.cos(armTilt) * armLen
  const headY = tipY - 0.04
  const headZ = tipZ + 0.18

  const pole = [
    { mesh: new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.38, 0.18, 8), concrete, count), ox: 0, oy: 0.09, oz: 0, rx: 0, ry: 0, rz: 0 },
    { mesh: new THREE.InstancedMesh(new THREE.CylinderGeometry(0.055, 0.1, poleH, 8), steel, count), ox: 0, oy: poleH / 2, oz: 0, rx: 0, ry: 0, rz: 0 },
  ]
  const arm = [
    { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.09, armLen), steelDark, count), ox: 0, oy: armY - Math.sin(armTilt) * (armLen / 2), oz: Math.cos(armTilt) * (armLen / 2), rx: armTilt, ry: 0, rz: 0 },
    { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.12, 0.85), housing, count), ox: 0, oy: headY, oz: headZ, rx: armTilt, ry: 0, rz: 0 },
    { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.04, 0.62), lampMat, count), ox: 0, oy: headY - 0.08, oz: headZ, rx: armTilt, ry: 0, rz: 0 },
  ]
  return { pole, arm }
}

function stampParts(parts, dummy, local, composed, i) {
  parts.forEach((part) => {
    local.position.set(part.ox, part.oy, part.oz)
    local.rotation.set(part.rx, part.ry, part.rz)
    local.scale.set(1, 1, 1)
    local.updateMatrix()
    composed.multiplyMatrices(dummy.matrix, local.matrix)
    part.mesh.setMatrixAt(i, composed)
  })
}

function addKitToScene(root, kit) {
  ;[...kit.pole, ...kit.arm].forEach((part) => {
    part.mesh.instanceMatrix.needsUpdate = true
    part.mesh.castShadow = false
    part.mesh.frustumCulled = true
    root.add(part.mesh)
  })
}

/** Highway cobra-head: single-arm on outer edges, double-arm on median. */
function addStreetLights(root, list, origin, medianPts) {
  if (!list?.length) return 0
  const singles = []
  const doubles = []
  list.forEach((p) => {
    const placed = placeStreetLight(p, origin, medianPts)
    if (placed.doubleArm) doubles.push(placed)
    else singles.push(placed)
  })

  const dummy = new THREE.Object3D()
  const local = new THREE.Object3D()
  const composed = new THREE.Matrix4()

  if (singles.length) {
    const kit = streetLightKit(singles.length)
    singles.forEach((s, i) => {
      dummy.position.set(s.x, 0, s.z)
      dummy.rotation.set(0, s.yaw, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      stampParts(kit.pole, dummy, local, composed, i)
      stampParts(kit.arm, dummy, local, composed, i)
    })
    addKitToScene(root, kit)
  }

  if (doubles.length) {
    const poleKit = streetLightKit(doubles.length)
    const armB = streetLightKit(doubles.length).arm
    doubles.forEach((s, i) => {
      dummy.position.set(s.x, 0, s.z)
      dummy.rotation.set(0, s.yaw, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      stampParts(poleKit.pole, dummy, local, composed, i)
      stampParts(poleKit.arm, dummy, local, composed, i)
      dummy.rotation.set(0, s.yaw + Math.PI, 0)
      dummy.updateMatrix()
      stampParts(armB, dummy, local, composed, i)
    })
    addKitToScene(root, poleKit)
    armB.forEach((part) => {
      part.mesh.instanceMatrix.needsUpdate = true
      part.mesh.castShadow = true
      root.add(part.mesh)
    })
  }

  return list.length
}

function hash01(i, salt = 1) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Canopy clearance (m) so crowns don't overhang asphalt or shoulders. */
const TREE_CLEAR_M = 2.2

function hasServiceRoadAt(km, side) {
  return SERVICE_SEGMENTS.some(
    (s) =>
      dirSideSign(s.dir) === side &&
      km >= Number(s.start) - SERVICE_SLIP_KM &&
      km <= Number(s.end) + SERVICE_SLIP_KM,
  )
}

/**
 * Keep GPS side + along-road position, but move the tree laterally off every paved strip:
 * outside main shoulder/barrier, and beyond the service road (incl. slips) where one exists.
 */
function placeTreeOffRoad(p, i, origin, medianPts) {
  const loc = lngLatToLocal(p.lng, p.lat, origin)
  if (!medianPts?.length) return loc
  let best = 0
  let bestD = Infinity
  for (let k = 0; k < medianPts.length; k++) {
    const d = (medianPts[k].x - loc.x) ** 2 + (medianPts[k].z - loc.z) ** 2
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  const f = nearestMedianFrame(loc, medianPts)
  const lateral = (loc.x - f.x) * f.nx + (loc.z - f.z) * f.nz
  const side = Math.abs(lateral) < 2 ? dirSideSign(p.dir) : lateral >= 0 ? SIDE_RHS : SIDE_LHS
  const { cumDist, totalM } = cumulativeFor(medianPts)
  const km = CHAINAGE_MIN_KM + (cumDist[best] / (totalM || 1)) * (CHAINAGE_MAX_KM - CHAINAGE_MIN_KM)

  const mainClear = KERB_EDGE_M + 1.7 + TREE_CLEAR_M
  const serviceClear = SERVICE_ROAD_CENTRE_M + SERVICE_ROAD_WIDTH_M / 2 + 1 + TREE_CLEAR_M
  const minOff = hasServiceRoadAt(km, side) ? serviceClear : mainClear
  let off = Math.abs(lateral)
  if (off < minOff) off = minOff + hash01(i, 21) * 5
  return {
    x: f.x + f.nx * off * side + f.tx * (hash01(i, 23) - 0.5) * 2,
    z: f.z + f.nz * off * side + f.tz * (hash01(i, 23) - 0.5) * 2,
  }
}

function addTrees(root, list, origin, medianPts) {
  if (!list?.length) return 0
  const count = list.length
  const dummy = new THREE.Object3D()
  const local = new THREE.Object3D()
  const composed = new THREE.Matrix4()

  const bark = new THREE.MeshStandardMaterial({ color: 0x4a3428, roughness: 0.96, metalness: 0 })
  const leafA = new THREE.MeshStandardMaterial({ color: 0x2a6a30, roughness: 0.84, metalness: 0 })
  const leafB = new THREE.MeshStandardMaterial({ color: 0x3f8f44, roughness: 0.8, metalness: 0 })
  const leafC = new THREE.MeshStandardMaterial({ color: 0x1c4f24, roughness: 0.88, metalness: 0 })

  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.2, 2.1, 8), bark, count)
  const canopyLow = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.25, 0), leafA, count)
  const canopyMid = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.05, 0), leafB, count)
  const canopyTop = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.78, 0), leafC, count)
  canopyLow.geometry.scale(1.05, 0.72, 1.0)
  canopyMid.geometry.scale(1.1, 0.78, 0.95)
  canopyTop.geometry.scale(0.92, 0.88, 1.02)

  const parts = [
    { mesh: trunk, ox: 0, oy: 1.05, oz: 0, sx: 1, sy: 1, sz: 1 },
    { mesh: canopyLow, ox: 0.16, oy: 2.45, oz: -0.1, sx: 1, sy: 1, sz: 1 },
    { mesh: canopyMid, ox: -0.22, oy: 3.05, oz: 0.16, sx: 1, sy: 1, sz: 1 },
    { mesh: canopyTop, ox: 0.06, oy: 3.7, oz: 0.02, sx: 1, sy: 1, sz: 1 },
  ]

  list.forEach((p, i) => {
    const loc = placeTreeOffRoad(p, i, origin, medianPts)
    const s = 0.78 + hash01(i, 1) * 0.55
    const yaw = hash01(i, 2) * Math.PI * 2
    dummy.position.set(loc.x, 0, loc.z)
    dummy.rotation.set(0, yaw, 0)
    dummy.scale.set(s, s, s)
    dummy.updateMatrix()
    parts.forEach((part, pi) => {
      const jx = (hash01(i, 3 + pi) - 0.5) * 0.16
      const jz = (hash01(i, 7 + pi) - 0.5) * 0.16
      local.position.set(part.ox + jx, part.oy, part.oz + jz)
      local.rotation.set(0, hash01(i, 11 + pi) * 0.8, 0)
      local.scale.set(part.sx, part.sy, part.sz)
      local.updateMatrix()
      composed.multiplyMatrices(dummy.matrix, local.matrix)
      part.mesh.setMatrixAt(i, composed)
    })
  })

  parts.forEach((part) => {
    part.mesh.instanceMatrix.needsUpdate = true
    part.mesh.castShadow = false
    part.mesh.receiveShadow = false
    part.mesh.frustumCulled = true
    root.add(part.mesh)
  })
  return count
}

function boxMesh(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
}

function uniqueByChainage(list) {
  const seen = new Map()
  list.forEach((p) => {
    const k = Number.isFinite(p.start)
      ? `ch-${p.start.toFixed(1)}`
      : `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`
    if (!seen.has(k)) seen.set(k, p)
  })
  return [...seen.values()]
}

/** Full-width highway toll plaza spanning both carriageways + median. */
function addTollPlazas(root, list, origin, medianPts) {
  if (!list?.length) return 0
  const plazas = uniqueByChainage(list)

  const conc = new THREE.MeshStandardMaterial({ color: 0xd6dbe2, roughness: 0.86, metalness: 0.04 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x546e7a, metalness: 0.55, roughness: 0.4 })
  const canopy = new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.45, metalness: 0.25 })
  const fascia = new THREE.MeshStandardMaterial({ color: 0xffc107, roughness: 0.4, metalness: 0.15 })
  const booth = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.7, metalness: 0.05 })
  const boothRoof = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.5, metalness: 0.1 })
  const glass = new THREE.MeshStandardMaterial({ color: 0x90caf9, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.55 })
  const island = new THREE.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.7, metalness: 0.05 })
  const islandDark = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8, metalness: 0.05 })
  const boom = new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.45, metalness: 0.2 })
  const sign = new THREE.MeshStandardMaterial({ color: 0x0d47a1, roughness: 0.4, metalness: 0.1 })

  const halfMed = ROAD_SPEC.medianWidthM / 2
  const lane = ROAD_SPEC.laneWidthM
  const span = halfMed + lane * 2 + 1.2
  const canopyZ = span * 2 + 2.4
  const canopyX = 14
  const roofY = 6.4

  // Lane island Z positions: between lanes and at median edges
  const islandsZ = [
    -(halfMed + lane),
    -halfMed,
    halfMed,
    halfMed + lane,
  ]
  const boothsZ = [
    -(halfMed + lane * 1.5),
    -(halfMed + lane * 0.5),
    halfMed + lane * 0.5,
    halfMed + lane * 1.5,
  ]

  plazas.forEach((p) => {
    const loc = lngLatToLocal(p.lng, p.lat, origin)
    const f = medianPts?.length
      ? recordFrame(medianPts, p.start, p.end, loc)
      : { x: loc.x, z: loc.z, nx: 0, nz: 1 }
    const g = new THREE.Group()
    g.position.set(f.x, 0, f.z)
    g.rotation.y = Math.atan2(f.nx, f.nz) // local +Z across the road

    const roof = boxMesh(canopyX, 0.35, canopyZ, canopy)
    roof.position.y = roofY
    g.add(roof)
    const fasciaBar = boxMesh(canopyX + 0.2, 0.55, 0.18, fascia)
    fasciaBar.position.set(0, roofY - 0.15, canopyZ / 2 + 0.05)
    g.add(fasciaBar)
    const fasciaBar2 = fasciaBar.clone()
    fasciaBar2.position.z = -(canopyZ / 2 + 0.05)
    g.add(fasciaBar2)
    const signBoard = boxMesh(8, 1.2, 0.12, sign)
    signBoard.position.set(0, roofY + 0.85, 0)
    g.add(signBoard)
    const signStripe = boxMesh(8.1, 0.18, 0.13, fascia)
    signStripe.position.set(0, roofY + 1.5, 0)
    g.add(signStripe)

    const colXs = [-5.5, 0, 5.5]
    const colZs = [-span, -halfMed - 0.2, 0, halfMed + 0.2, span]
    colXs.forEach((x) => {
      colZs.forEach((z) => {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, roofY, 8), steel)
        col.position.set(x, roofY / 2, z)
        g.add(col)
      })
    })

    islandsZ.forEach((z) => {
      const pad = boxMesh(8.5, 0.22, 0.7, island)
      pad.position.set(0, 0.12, z)
      g.add(pad)
      const stripe = boxMesh(8.5, 0.04, 0.18, islandDark)
      stripe.position.set(0, 0.24, z)
      g.add(stripe)
    })

    boothsZ.forEach((z, i) => {
      const cabin = boxMesh(2.4, 2.2, 1.35, booth)
      cabin.position.set(i % 2 === 0 ? -1.1 : 1.1, 1.2, z)
      g.add(cabin)
      const winF = boxMesh(1.4, 0.85, 0.06, glass)
      winF.position.set(cabin.position.x, 1.45, z + (z > 0 ? -0.7 : 0.7))
      g.add(winF)
      const roofB = boxMesh(2.7, 0.12, 1.6, boothRoof)
      roofB.position.set(cabin.position.x, 2.38, z)
      g.add(roofB)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 6), steel)
      pole.position.set(cabin.position.x + (i % 2 === 0 ? 1.35 : -1.35), 1.4, z)
      g.add(pole)
      const arm = boxMesh(2.8, 0.08, 0.1, boom)
      arm.position.set(cabin.position.x + (i % 2 === 0 ? 2.7 : -2.7), 1.9, z)
      arm.rotation.z = i % 2 === 0 ? -0.55 : 0.55
      g.add(arm)
    })

    const office = boxMesh(6.5, 3.6, 4.2, booth)
    office.position.set(-1, 1.8, span + 3.4)
    g.add(office)
    const officeRoof = boxMesh(7.1, 0.22, 4.7, canopy)
    officeRoof.position.set(-1, 3.72, span + 3.4)
    g.add(officeRoof)
    const officeWin = boxMesh(4.2, 1.2, 0.08, glass)
    officeWin.position.set(-1, 2.1, span + 3.4 - 2.12)
    g.add(officeWin)

    g.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })
    root.add(g)
  })
  return plazas.length
}

function addFuelStations(root, list, origin, medianPts) {
  if (!list?.length) return 0
  const stations = uniqueByChainage(list)
  const offsetM = LIGHT_SHOULDER_M + 9.5

  const slab = new THREE.MeshStandardMaterial({ color: 0xb0b7c0, roughness: 0.92, metalness: 0.04 })
  const canopy = new THREE.MeshStandardMaterial({ color: 0xf5f7fa, roughness: 0.45, metalness: 0.12 })
  const fascia = new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.4, metalness: 0.15 })
  const accent = new THREE.MeshStandardMaterial({ color: 0xffc107, roughness: 0.45, metalness: 0.1 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x455a64, metalness: 0.5, roughness: 0.4 })
  const pump = new THREE.MeshStandardMaterial({ color: 0x1a237e, roughness: 0.4, metalness: 0.2 })
  const pumpFace = new THREE.MeshStandardMaterial({ color: 0xe3f2fd, roughness: 0.25, metalness: 0.1 })
  const shop = new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.72, metalness: 0.05 })
  const shopRoof = new THREE.MeshStandardMaterial({ color: 0x0d47a1, roughness: 0.5, metalness: 0.12 })
  const glass = new THREE.MeshStandardMaterial({ color: 0x90caf9, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.5 })
  const island = new THREE.MeshStandardMaterial({ color: 0xffecb3, roughness: 0.75, metalness: 0.04 })

  stations.forEach((p) => {
    const loc = lngLatToLocal(p.lng, p.lat, origin)
    const f = medianPts?.length
      ? recordFrame(medianPts, p.start, p.end, loc)
      : { x: loc.x, z: loc.z, nx: 1, nz: 0 }
    const sign = dirSideSign(p.dir)
    const placed = {
      x: f.x + f.nx * offsetM * sign,
      z: f.z + f.nz * offsetM * sign,
      yaw: Math.atan2(-f.nx * sign, -f.nz * sign),
    }

    const g = new THREE.Group()
    g.position.set(placed.x, 0, placed.z)
    g.rotation.y = placed.yaw // +Z toward the road

    const pad = boxMesh(22, 0.12, 16, slab)
    pad.position.set(0, 0.06, 0)
    g.add(pad)

    const roof = boxMesh(16, 0.28, 10, canopy)
    roof.position.set(0, 5.15, 1.2)
    g.add(roof)
    const band = boxMesh(16.2, 0.42, 0.16, fascia)
    band.position.set(0, 4.95, 6.28)
    g.add(band)
    const band2 = boxMesh(16.2, 0.42, 0.16, fascia)
    band2.position.set(0, 4.95, -3.88)
    g.add(band2)
    const stripe = boxMesh(16.2, 0.12, 10.2, accent)
    stripe.position.set(0, 5.32, 1.2)
    g.add(stripe)

    ;[-6, -2, 2, 6].forEach((x) => {
      ;[-2.2, 4.4].forEach((z) => {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 5.1, 8), steel)
        col.position.set(x, 2.55, z)
        g.add(col)
      })
    })

    const pumpXs = [-5, -1.7, 1.7, 5]
    pumpXs.forEach((x) => {
      const isle = boxMesh(1.1, 0.18, 3.6, island)
      isle.position.set(x, 0.18, 1.1)
      g.add(isle)
      ;[-0.7, 1.1].forEach((z) => {
        const body = boxMesh(0.55, 1.55, 0.7, pump)
        body.position.set(x, 1.0, z)
        g.add(body)
        const screen = boxMesh(0.42, 0.38, 0.04, pumpFace)
        screen.position.set(x, 1.45, z + (z > 0.2 ? 0.38 : -0.38))
        g.add(screen)
        const hose = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), steel)
        hose.position.set(x + 0.32, 0.85, z)
        hose.rotation.z = 0.35
        g.add(hose)
      })
    })

    const store = boxMesh(10, 3.2, 5.2, shop)
    store.position.set(0, 1.7, -6.4)
    g.add(store)
    const storeRoof = boxMesh(10.6, 0.22, 5.7, shopRoof)
    storeRoof.position.set(0, 3.38, -6.4)
    g.add(storeRoof)
    const storeWin = boxMesh(7.2, 1.5, 0.08, glass)
    storeWin.position.set(0, 1.85, -3.76)
    g.add(storeWin)
    const door = boxMesh(1.4, 2.2, 0.08, fascia)
    door.position.set(3.2, 1.2, -3.76)
    g.add(door)

    const totem = boxMesh(0.45, 8.2, 0.28, fascia)
    totem.position.set(-9.4, 4.1, 6.4)
    g.add(totem)
    const board = boxMesh(1.8, 2.4, 0.16, pump)
    board.position.set(-9.4, 7.4, 6.4)
    g.add(board)
    const boardAccent = boxMesh(1.85, 0.28, 0.18, accent)
    boardAccent.position.set(-9.4, 8.7, 6.4)
    g.add(boardAccent)

    g.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })
    root.add(g)
  })
  return stations.length
}

function placeOnCorridor(p, origin, medianPts, offsetM = LIGHT_SHOULDER_M + 0.4) {
  const loc = lngLatToLocal(p.lng, p.lat, origin)
  if (!medianPts?.length) return { x: loc.x, z: loc.z, yaw: 0 }
  const f = recordFrame(medianPts, p.start, p.end, loc)
  const d = String(p.dir || '').toLowerCase()
  if (d.startsWith('med')) return { x: f.x, z: f.z, yaw: Math.atan2(f.nx, f.nz) }
  if (d.startsWith('inc') || d.startsWith('dec')) {
    const sign = dirSideSign(p.dir)
    const off = sideOffsetM(p, offsetM)
    return {
      x: f.x + f.nx * off * sign,
      z: f.z + f.nz * off * sign,
      yaw: Math.atan2(-f.nx * sign, -f.nz * sign),
    }
  }
  return { x: loc.x, z: loc.z, yaw: Math.atan2(f.x - loc.x, f.z - loc.z) }
}

/** Sign face parallel to road (horizontal along corridor), facing oncoming traffic. */
function placeSignBoard(p, origin, medianPts, offsetM = LIGHT_SHOULDER_M + 0.4) {
  const loc = lngLatToLocal(p.lng, p.lat, origin)
  if (!medianPts?.length) return { x: loc.x, z: loc.z, yaw: 0 }
  const f = recordFrame(medianPts, p.start, p.end, loc)
  const d = String(p.dir || '').toLowerCase()
  const yawInc = Math.atan2(-f.tx, -f.tz)
  const yawDec = Math.atan2(f.tx, f.tz)
  if (d.startsWith('med')) return { x: f.x, z: f.z, yaw: yawInc }
  if (d.startsWith('inc') || d.startsWith('dec')) {
    const sign = dirSideSign(p.dir)
    const off = sideOffsetM(p, offsetM)
    return {
      x: f.x + f.nx * off * sign,
      z: f.z + f.nz * off * sign,
      yaw: d.startsWith('dec') ? yawDec : yawInc,
    }
  }
  return { x: loc.x, z: loc.z, yaw: yawInc }
}

function addInstancedKit(root, placements, specs) {
  if (!placements.length || !specs.length) return
  const dummy = new THREE.Object3D()
  const local = new THREE.Object3D()
  const composed = new THREE.Matrix4()
  const meshes = specs.map((s) => new THREE.InstancedMesh(s.geo, s.mat, placements.length))
  placements.forEach((pl, i) => {
    dummy.position.set(pl.x, 0, pl.z)
    dummy.rotation.set(0, pl.yaw || 0, 0)
    dummy.scale.set(pl.s || 1, pl.s || 1, pl.s || 1)
    dummy.updateMatrix()
    specs.forEach((s, si) => {
      local.position.set(s.ox || 0, s.oy || 0, s.oz || 0)
      local.rotation.set(s.rx || 0, s.ry || 0, s.rz || 0)
      local.scale.set(1, 1, 1)
      local.updateMatrix()
      composed.multiplyMatrices(dummy.matrix, local.matrix)
      meshes[si].setMatrixAt(i, composed)
    })
  })
  meshes.forEach((mesh) => {
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    root.add(mesh)
  })
}

function addRoadFurniture(root, list, asset, origin, medianPts) {
  const placements = list.map((p) => placeOnCorridor(p, origin, medianPts))
  const steel = new THREE.MeshStandardMaterial({ color: 0x5b6570, metalness: 0.55, roughness: 0.35 })
  const conc = new THREE.MeshStandardMaterial({ color: 0xc5ccd3, roughness: 0.82, metalness: 0.04 })
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.45, metalness: 0.06 })
  const green = new THREE.MeshStandardMaterial({ color: 0x1b5e20, roughness: 0.5, metalness: 0.08 })
  const orange = new THREE.MeshStandardMaterial({ color: 0xef6c00, roughness: 0.42, metalness: 0.08 })
  const black = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.55, metalness: 0.05 })
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf6c445, roughness: 0.48, metalness: 0.06 })
  const glass = new THREE.MeshStandardMaterial({ color: 0x90caf9, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.45 })
  const roof = new THREE.MeshStandardMaterial({ color: 0x37474f, metalness: 0.4, roughness: 0.4 })

  if (asset === 'Sign Boards') {
    addInstancedKit(root, list.map((p) => placeSignBoard(p, origin, medianPts)), [
      { geo: new THREE.CylinderGeometry(0.045, 0.055, 2.7, 8), mat: steel, oy: 1.35 },
      { geo: new THREE.BoxGeometry(1.15, 0.95, 0.06), mat: green, oy: 2.85, oz: 0.04 },
      { geo: new THREE.BoxGeometry(0.95, 0.72, 0.03), mat: white, oy: 2.85, oz: 0.08 },
    ])
    return list.length
  }
  if (asset === 'Hazard Markers') {
    addInstancedKit(root, placements, [
      { geo: new THREE.CylinderGeometry(0.04, 0.05, 1.6, 8), mat: steel, oy: 0.8 },
      { geo: new THREE.BoxGeometry(0.7, 0.7, 0.07), mat: orange, oy: 1.85, oz: 0.04, rz: Math.PI / 4 },
      { geo: new THREE.BoxGeometry(0.22, 0.55, 0.04), mat: black, oy: 1.85, oz: 0.08 },
    ])
    return list.length
  }
  if (asset === 'KM Stones') {
    addInstancedKit(root, placements, [
      { geo: new THREE.BoxGeometry(0.42, 0.95, 0.28), mat: yellow, oy: 0.48 },
      { geo: new THREE.BoxGeometry(0.38, 0.28, 0.08), mat: black, oy: 0.72, oz: 0.12 },
      { geo: new THREE.BoxGeometry(0.5, 0.08, 0.36), mat: conc, oy: 0.04 },
    ])
    return list.length
  }
  if (asset === 'Delineators') {
    addInstancedKit(root, placements, [
      { geo: new THREE.CylinderGeometry(0.035, 0.04, 1.15, 8), mat: steel, oy: 0.58 },
      { geo: new THREE.BoxGeometry(0.12, 0.22, 0.05), mat: yellow, oy: 1.12, oz: 0.02 },
    ])
    return list.length
  }
  if (asset === 'Culvert') {
    addInstancedKit(root, placements, [
      { geo: new THREE.BoxGeometry(3.4, 1.15, 2.2), mat: conc, oy: 0.4 },
      { geo: new THREE.BoxGeometry(2.2, 0.55, 0.2), mat: black, oy: 0.38, oz: 1.05 },
    ])
    return list.length
  }
  if (asset === 'Bus Shelters') {
    addInstancedKit(root, placements, [
      { geo: new THREE.BoxGeometry(4.4, 0.12, 2.2), mat: roof, oy: 2.55 },
      { geo: new THREE.CylinderGeometry(0.06, 0.06, 2.5, 8), mat: steel, ox: -1.9, oy: 1.25, oz: -0.85 },
      { geo: new THREE.CylinderGeometry(0.06, 0.06, 2.5, 8), mat: steel, ox: 1.9, oy: 1.25, oz: -0.85 },
      { geo: new THREE.CylinderGeometry(0.06, 0.06, 2.5, 8), mat: steel, ox: -1.9, oy: 1.25, oz: 0.85 },
      { geo: new THREE.CylinderGeometry(0.06, 0.06, 2.5, 8), mat: steel, ox: 1.9, oy: 1.25, oz: 0.85 },
      { geo: new THREE.BoxGeometry(4.0, 1.1, 0.06), mat: glass, oy: 1.5, oz: -1.05 },
      { geo: new THREE.BoxGeometry(3.6, 0.08, 0.45), mat: steel, oy: 0.48 },
    ])
    return list.length
  }
  if (asset === 'Bus Bays') {
    addInstancedKit(root, placements, [
      { geo: new THREE.BoxGeometry(12, 0.08, 3.2), mat: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.95 }), oy: 0.04 },
      { geo: new THREE.BoxGeometry(12, 0.03, 0.18), mat: yellow, oy: 0.09, oz: 1.5 },
      { geo: new THREE.BoxGeometry(3.8, 0.1, 1.8), mat: roof, oy: 2.4, oz: -0.4 },
    ])
    return list.length
  }
  if (asset === 'Truck Layby') {
    addInstancedKit(root, placements, [
      { geo: new THREE.BoxGeometry(18, 0.08, 5.5), mat: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.95 }), oy: 0.04 },
      { geo: new THREE.BoxGeometry(18, 0.03, 0.2), mat: yellow, oy: 0.09, oz: 2.6 },
    ])
    return list.length
  }
  if (asset === 'Solar Blinker') {
    const amber = new THREE.MeshStandardMaterial({ color: 0xffb300, emissive: 0xff8f00, emissiveIntensity: 1.2, roughness: 0.3 })
    const panel = new THREE.MeshStandardMaterial({ color: 0x1a237e, roughness: 0.25, metalness: 0.5 })
    addInstancedKit(root, placements, [
      { geo: new THREE.CylinderGeometry(0.05, 0.06, 2.6, 8), mat: steel, oy: 1.3 },
      { geo: new THREE.CylinderGeometry(0.16, 0.16, 0.12, 12), mat: amber, oy: 2.45, oz: 0.08, rx: Math.PI / 2 },
      { geo: new THREE.BoxGeometry(0.45, 0.03, 0.35), mat: panel, oy: 2.75, rx: -0.4 },
    ])
    return list.length
  }
  if (asset === 'Pedestrian Guard Rail') {
    addInstancedKit(root, placements, [
      { geo: new THREE.BoxGeometry(6, 0.06, 0.06), mat: yellow, oy: 1.0 },
      { geo: new THREE.BoxGeometry(6, 0.05, 0.05), mat: black, oy: 0.55 },
      { geo: new THREE.BoxGeometry(0.06, 1.05, 0.06), mat: steel, ox: -2.9, oy: 0.52 },
      { geo: new THREE.BoxGeometry(0.06, 1.05, 0.06), mat: steel, oy: 0.52 },
      { geo: new THREE.BoxGeometry(0.06, 1.05, 0.06), mat: steel, ox: 2.9, oy: 0.52 },
    ])
    return list.length
  }
  addInstancedKit(root, placements, [
    { geo: new THREE.CylinderGeometry(0.22, 0.28, 0.7, 10), mat: conc, oy: 0.35 },
  ])
  return list.length
}

const MEDIAN_TREES_PER_RECORD = 2
const MEDIAN_TREE_VARIANTS = [11, 29, 47]
const MEDIAN_CANOPY_W = 2.1
const MEDIAN_CANOPY_H = 2.1
const MEDIAN_CANOPY_BASE_Y = 0.85

function seededRandom(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const medianCanopyCache = new Map()

/**
 * Transparent canopy-card texture for a young median tree: fine branches from
 * the trunk top into leaf clumps, and an oval crown of small ovate leaves —
 * dark inner shadow, mid greens, and pale sunlit leaves toward the upper side.
 */
function medianCanopyTexture(seed) {
  const cached = medianCanopyCache.get(seed)
  if (cached) return cached
  const w = 512
  const h = 616
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  const rnd = seededRandom(seed)
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5
  const cx = w / 2
  const cy = h * 0.46
  const rx = w * 0.44
  const ry = h * 0.43
  const inCrown = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

  const clumps = []
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2
    const r = Math.sqrt(rnd()) * 0.72
    clumps.push({ x: cx + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r, s: 46 + rnd() * 40 })
  }

  g.lineCap = 'round'
  const trunkX = cx + (rnd() - 0.5) * 8
  clumps.forEach((cl) => {
    g.strokeStyle = rnd() > 0.5 ? '#6f5a55' : '#7d6862'
    g.lineWidth = 2 + rnd() * 3
    g.beginPath()
    g.moveTo(trunkX, h)
    g.quadraticCurveTo(trunkX + (cl.x - trunkX) * 0.25, cl.y + (h - cl.y) * 0.45, cl.x, cl.y)
    g.stroke()
  })

  const leaf = (x, y, size, fill, edge) => {
    g.save()
    g.translate(x, y)
    g.rotate(rnd() * Math.PI * 2)
    g.beginPath()
    g.ellipse(0, 0, size, size * 0.58, 0, 0, Math.PI * 2)
    g.fillStyle = fill
    g.fill()
    if (edge) {
      g.strokeStyle = edge
      g.lineWidth = 1.1
      g.stroke()
    }
    g.restore()
  }

  const scatter = (n, spread, pick) => {
    for (let i = 0; i < n; i++) {
      const cl = clumps[Math.floor(rnd() * clumps.length)]
      const x = cl.x + gauss() * cl.s * spread
      const y = cl.y + gauss() * cl.s * spread * 0.85
      if (!inCrown(x, y)) continue
      pick(x, y)
    }
  }

  scatter(900, 0.9, (x, y) => {
    const j = Math.round((rnd() - 0.5) * 16)
    leaf(x, y, 6 + rnd() * 3, `rgb(${28 + j},${66 + j},${30 + j})`)
  })
  scatter(1000, 1.05, (x, y) => {
    const j = Math.round((rnd() - 0.5) * 24)
    leaf(x, y, 5.5 + rnd() * 3, `rgb(${58 + j},${112 + j},${44 + j})`, 'rgba(20,50,20,0.35)')
  })
  scatter(700, 1.15, (x, y) => {
    const sun = Math.max(0, Math.min(1, 0.55 - (y - cy) / (ry * 2) - (x - cx) / (rx * 4)))
    if (rnd() > 0.35 + sun * 0.6) return
    const t = rnd()
    const fill = t < 0.45 ? '#a9c97a' : t < 0.8 ? '#d3e3a8' : '#eef3d6'
    leaf(x, y, 4.5 + rnd() * 2.5, fill, 'rgba(60,110,40,0.55)')
  })

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.needsUpdate = true
  sharedTextures.add(tex)
  medianCanopyCache.set(seed, tex)
  return tex
}

/**
 * Young median trees: slim trunk on a square grass bed, with an oval leafy
 * crown made of crossed alpha-tested canopy cards. Trees sit just off the
 * centreline so they don't clash with median light poles.
 */
function addMedianPlants(root, list, origin, medianPts) {
  if (!list?.length || !medianPts?.length) return 0
  const dummy = new THREE.Object3D()
  const local = new THREE.Object3D()
  const composed = new THREE.Matrix4()
  const tint = new THREE.Color()

  const trees = []
  list.forEach((p, ri) => {
    const km = (Number(p.start) + Number(p.end ?? p.start)) / 2
    if (!Number.isFinite(km)) return
    const f = chainageFrame(medianPts, km)
    const spanM = Math.max(6, (Math.abs(Number(p.end) - Number(p.start)) || 0.01) * 1000)
    for (let k = 0; k < MEDIAN_TREES_PER_RECORD; k++) {
      const seed = ri * MEDIAN_TREES_PER_RECORD + k
      const along = ((k + 0.5) / MEDIAN_TREES_PER_RECORD - 0.5) * spanM + (hash01(seed, 21) - 0.5) * 0.6
      const side = (k % 2 ? 1 : -1) * (0.35 + hash01(seed, 22) * 0.15)
      trees.push({
        seed,
        x: f.x + f.tx * along + f.nx * side,
        z: f.z + f.tz * along + f.nz * side,
        yawBed: Math.atan2(f.tx, f.tz),
        variant: Math.floor(hash01(seed, 26) * MEDIAN_TREE_VARIANTS.length),
      })
    }
  })
  if (!trees.length) return 0

  const cardGeo = new THREE.PlaneGeometry(MEDIAN_CANOPY_W, MEDIAN_CANOPY_H)
  cardGeo.translate(0, MEDIAN_CANOPY_BASE_Y + MEDIAN_CANOPY_H / 2, 0)
  const trunkGeo = new THREE.CylinderGeometry(0.04, 0.065, MEDIAN_CANOPY_BASE_Y + 0.4, 7)
  trunkGeo.translate(0, (MEDIAN_CANOPY_BASE_Y + 0.4) / 2, 0)
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a6560, roughness: 0.9, metalness: 0 })
  const bedGeo = new THREE.PlaneGeometry(1.7, 1.7)
  bedGeo.rotateX(-Math.PI / 2)
  bedGeo.translate(0, 0.035, 0)
  const bedMat = new THREE.MeshStandardMaterial({ color: 0x78a85a, roughness: 0.95, metalness: 0 })
  const pitGeo = new THREE.CircleGeometry(0.28, 14)
  pitGeo.rotateX(-Math.PI / 2)
  pitGeo.translate(0, 0.04, 0)
  const pitMat = new THREE.MeshStandardMaterial({ color: 0xc9d3bf, roughness: 1, metalness: 0 })

  const cardYaws = [0, Math.PI / 3, (2 * Math.PI) / 3]
  const meshes = []

  const placeTree = (b) => {
    const s = 0.9 + hash01(b.seed, 23) * 0.2
    dummy.position.set(b.x, 0, b.z)
    dummy.rotation.set(0, hash01(b.seed, 24) * Math.PI * 2, 0)
    dummy.scale.set(s, s * (0.94 + hash01(b.seed, 25) * 0.12), s)
    dummy.updateMatrix()
  }

  MEDIAN_TREE_VARIANTS.forEach((texSeed, vi) => {
    const group = trees.filter((b) => b.variant === vi)
    if (!group.length) return
    const mat = new THREE.MeshStandardMaterial({
      map: medianCanopyTexture(texSeed),
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.78,
      metalness: 0,
    })
    const cards = cardYaws.map(() => new THREE.InstancedMesh(cardGeo, mat, group.length))
    group.forEach((b, i) => {
      placeTree(b)
      cardYaws.forEach((yaw, ci) => {
        local.position.set(0, 0, 0)
        local.rotation.set(0, yaw + (hash01(b.seed, 40 + ci) - 0.5) * 0.2, 0)
        local.scale.set(1, 1, 1)
        local.updateMatrix()
        composed.multiplyMatrices(dummy.matrix, local.matrix)
        cards[ci].setMatrixAt(i, composed)
        const v = 0.9 + hash01(b.seed, 60 + ci) * 0.12
        cards[ci].setColorAt(i, tint.setRGB(v * 0.98, v, v * 0.94))
      })
    })
    meshes.push(...cards)
  })

  const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length)
  const bed = new THREE.InstancedMesh(bedGeo, bedMat, trees.length)
  const pit = new THREE.InstancedMesh(pitGeo, pitMat, trees.length)
  trees.forEach((b, i) => {
    placeTree(b)
    trunk.setMatrixAt(i, dummy.matrix)
    pit.setMatrixAt(i, dummy.matrix)
    dummy.rotation.set(0, b.yawBed, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    bed.setMatrixAt(i, dummy.matrix)
  })
  meshes.push(trunk, bed, pit)

  meshes.forEach((mesh) => {
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.computeBoundingSphere()
    root.add(mesh)
  })
  return list.length
}

const GANTRY_PANELS = 4

/** Soft blurred word-shapes standing in for sign legends (no real destination text). */
function drawBlurredLegend(g, x, y, maxW, lineH, rnd) {
  const words = 1 + Math.floor(rnd() * 2)
  let cx = x
  g.save()
  if ('filter' in g) g.filter = 'blur(9px)'
  g.fillStyle = 'rgba(255,255,255,0.85)'
  for (let i = 0; i < words && cx < x + maxW; i++) {
    const ww = Math.min(x + maxW - cx, maxW * (0.38 + rnd() * 0.4))
    g.beginPath()
    g.roundRect(cx, y - lineH, ww, lineH, lineH * 0.3)
    g.fill()
    cx += ww + lineH * 0.5
  }
  g.restore()
}

function gantryBoardTexture(dir, km) {
  const rnd = seededRandom(Math.round(km * 1000) + (dir === 'Decreasing' ? 7 : 3))
  const w = 2048
  const h = 400
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.fillStyle = '#0a6b3d'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = '#ffffff'
  g.lineWidth = 10
  g.strokeRect(14, 14, w - 28, h - 28)

  const pw = (w - 28) / GANTRY_PANELS
  for (let i = 0; i < GANTRY_PANELS; i++) {
    const x0 = 14 + i * pw
    if (i > 0) {
      g.fillStyle = '#ffffff'
      g.fillRect(x0 - 5, 14, 10, h - 28)
    }
    const pad = 34
    drawBlurredLegend(g, x0 + pad, 165, pw - pad * 2 - 110, 86, rnd)

    g.fillStyle = '#ffffff'
    const ax = x0 + pw - pad - 34
    g.beginPath()
    g.moveTo(ax, 62)
    g.lineTo(ax + 34, 108)
    g.lineTo(ax + 12, 108)
    g.lineTo(ax + 12, 168)
    g.lineTo(ax - 12, 168)
    g.lineTo(ax - 12, 108)
    g.lineTo(ax - 34, 108)
    g.closePath()
    g.fill()

    drawBlurredLegend(g, x0 + pad, 325, pw - pad * 2 - 140, 62, rnd)
    g.save()
    if ('filter' in g) g.filter = 'blur(8px)'
    g.fillStyle = 'rgba(255,255,255,0.85)'
    g.beginPath()
    g.roundRect(x0 + pw - pad - 90, 325 - 62, 90, 62, 18)
    g.fill()
    g.restore()
  }

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/** One gantry per carriageway cluster; median-side records are the gantry's inner post. */
function gantryClusters(list) {
  const sided = list
    .filter((p) => /^(inc|dec)/i.test(String(p.dir || '')))
    .sort((a, b) => a.start - b.start)
  const out = []
  sided.forEach((p) => {
    const dir = String(p.dir).toLowerCase().startsWith('dec') ? 'Decreasing' : 'Increasing'
    const near = out.find((o) => o.dir === dir && Math.abs(o.km - p.start) < 0.2)
    if (!near) out.push({ dir, km: Number(p.start) })
  })
  list
    .filter((p) => String(p.dir || '').toLowerCase().startsWith('med'))
    .forEach((p) => {
      if (!out.some((o) => Math.abs(o.km - p.start) < 0.2)) out.push({ dir: 'Increasing', km: Number(p.start) })
    })
  return out
}

/**
 * Overhead gantry sign spanning one carriageway: two steel columns on
 * pedestals, angled braces, twin cross-beams and a green 4-panel
 * bilingual direction board facing oncoming traffic.
 */
function addGantrySigns(root, list, medianPts) {
  if (!list?.length || !medianPts?.length) return 0
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3c2, metalness: 0.7, roughness: 0.3 })
  const pedestal = new THREE.MeshStandardMaterial({ color: 0x4b5585, metalness: 0.5, roughness: 0.4 })
  const footing = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.9, metalness: 0 })
  const back = new THREE.MeshStandardMaterial({ color: 0x8c949c, metalness: 0.55, roughness: 0.45 })

  const innerM = ROAD_SPEC.medianWidthM / 2 - 0.7
  const outerM = KERB_EDGE_M + 1.1
  const span = outerM - innerM
  const colH = 7.2
  const boardW = span - 0.9
  const boardH = 1.55
  const boardY = 6.35
  const beamYs = [5.85, 6.85]

  const clusters = gantryClusters(list)
  clusters.forEach(({ dir, km }) => {
    const f = chainageFrame(medianPts, km)
    const sideSign = dirSideSign(dir)
    const travel = dir === 'Decreasing' ? -1 : 1
    const mid = (innerM + outerM) / 2
    const grp = new THREE.Group()
    grp.position.set(f.x + f.nx * mid * sideSign, 0, f.z + f.nz * mid * sideSign)
    grp.rotation.y = Math.atan2(-f.tx * travel, -f.tz * travel)

    ;[-span / 2, span / 2].forEach((x, side) => {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.25, 16), footing)
      foot.position.set(x, 0.12, 0)
      grp.add(foot)
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 1.2, 16), pedestal)
      base.position.set(x, 0.85, 0)
      grp.add(base)
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.35, 16), pedestal)
      collar.position.set(x, 1.62, 0)
      grp.add(collar)
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, colH - 1.6, 16), steel)
      col.position.set(x, 1.6 + (colH - 1.6) / 2, 0)
      grp.add(col)
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), steel)
      cap.position.set(x, colH, 0)
      grp.add(cap)

      const inward = side === 0 ? 1 : -1
      const bx0 = x + inward * 0.12
      const by0 = 4.6
      const bx1 = x + inward * 1.35
      const by1 = beamYs[0]
      const len = Math.hypot(bx1 - bx0, by1 - by0)
      const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, len, 10), steel)
      brace.position.set((bx0 + bx1) / 2, (by0 + by1) / 2, 0)
      brace.rotation.z = -Math.atan2(bx1 - bx0, by1 - by0)
      grp.add(brace)
    })

    beamYs.forEach((y) => {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, span, 12), steel)
      beam.rotation.z = Math.PI / 2
      beam.position.set(0, y, 0)
      grp.add(beam)
    })

    const face = new THREE.MeshStandardMaterial({
      map: gantryBoardTexture(dir, km),
      roughness: 0.55,
      metalness: 0.05,
    })
    const board = new THREE.Mesh(new THREE.BoxGeometry(boardW, boardH, 0.1), [back, back, back, back, face, back])
    board.position.set(0, boardY, 0.28)
    grp.add(board)

    grp.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    root.add(grp)
  })
  return list.length
}

/** Arrow pointing up (rot = 0) or rotated, centred on (cx, cy), height ≈ 2 × s. */
function drawSignArrow(g, cx, cy, s, rot = 0) {
  g.save()
  g.translate(cx, cy)
  g.rotate(rot)
  g.beginPath()
  g.moveTo(0, -s)
  g.lineTo(s * 0.72, -s * 0.28)
  g.lineTo(s * 0.26, -s * 0.28)
  g.lineTo(s * 0.26, s)
  g.lineTo(-s * 0.26, s)
  g.lineTo(-s * 0.26, -s * 0.28)
  g.lineTo(-s * 0.72, -s * 0.28)
  g.closePath()
  g.fillStyle = '#ffffff'
  g.fill()
  g.restore()
}

function cantileverBoardTexture(seed) {
  const rnd = seededRandom(seed)
  const w = 1024
  const h = 334
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.fillStyle = '#0a6b3d'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = '#ffffff'
  g.lineWidth = 8
  g.strokeRect(10, 10, w - 20, h - 20)
  g.fillStyle = '#ffffff'
  g.fillRect(w / 2 - 4, 40, 8, h - 80)

  // Left panel: ↖ arrow then legend; right panel: legend then ↑ arrow
  drawSignArrow(g, 80, h / 2, 60, -Math.PI / 4)
  drawBlurredLegend(g, 160, 150, w / 2 - 200, 70, rnd)
  drawBlurredLegend(g, 160, 272, w / 2 - 200, 62, rnd)
  drawBlurredLegend(g, w / 2 + 40, 150, w / 2 - 200, 70, rnd)
  drawBlurredLegend(g, w / 2 + 40, 272, w / 2 - 200, 62, rnd)
  drawSignArrow(g, w - 80, h / 2, 64, 0)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/**
 * Roadside cantilever sign: single grey column on the outer shoulder that
 * bends over into a horizontal arm carrying a green 2-panel direction board
 * above the near lanes, facing oncoming traffic.
 */
function addCantileverSigns(root, list, medianPts) {
  if (!list?.length || !medianPts?.length) return 0
  const steel = new THREE.MeshStandardMaterial({ color: 0x8d9197, metalness: 0.65, roughness: 0.35 })
  const footing = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.9, metalness: 0 })
  const back = new THREE.MeshStandardMaterial({ color: 0x8c949c, metalness: 0.55, roughness: 0.45 })

  const poleM = KERB_EDGE_M + 1.1
  const colH = 6.1
  const bendR = 0.8
  const armY = colH + bendR
  const armLen = 5.2
  const boardW = 4.6
  const boardH = 1.5
  const boardX0 = bendR + 0.15

  const sites = []
  ;[...list]
    .filter((p) => /^(inc|dec)/i.test(String(p.dir || '')))
    .sort((a, b) => a.start - b.start)
    .forEach((p) => {
      const dir = String(p.dir).toLowerCase().startsWith('dec') ? 'Decreasing' : 'Increasing'
      if (!sites.some((s) => s.dir === dir && Math.abs(s.km - p.start) < 0.05)) {
        sites.push({ dir, km: Number(p.start) })
      }
    })

  // Board faces the same way as roadside signs; the road then lies toward local +X.
  const ax = 1
  const bend = new THREE.TubeGeometry(
    new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, colH, 0),
      new THREE.Vector3(0, armY, 0),
      new THREE.Vector3(ax * bendR, armY, 0),
    ),
    16,
    0.13,
    12,
    false,
  )

  sites.forEach(({ dir, km }, si) => {
    const f = chainageFrame(medianPts, km)
    const sideSign = dirSideSign(dir)
    const travel = dir === 'Decreasing' ? -1 : 1
    const grp = new THREE.Group()
    grp.position.set(f.x + f.nx * poleM * sideSign, 0, f.z + f.nz * poleM * sideSign)
    grp.rotation.y = Math.atan2(-f.tx * travel, -f.tz * travel)

    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.56, 0.22, 16), footing)
    foot.position.y = 0.11
    grp.add(foot)
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.55), steel)
    plate.position.y = 0.26
    grp.add(plate)
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, colH - 0.3, 14), steel)
    col.position.y = 0.3 + (colH - 0.3) / 2
    grp.add(col)
    grp.add(new THREE.Mesh(bend, steel))
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, armLen - bendR, 12), steel)
    arm.rotation.z = Math.PI / 2
    arm.position.set(ax * (bendR + (armLen - bendR) / 2), armY, -0.05)
    grp.add(arm)
    const endCap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), steel)
    endCap.position.set(ax * armLen, armY, -0.05)
    grp.add(endCap)

    const face = new THREE.MeshStandardMaterial({
      map: cantileverBoardTexture(Math.round(km * 1000) + si),
      roughness: 0.55,
      metalness: 0.05,
    })
    const board = new THREE.Mesh(new THREE.BoxGeometry(boardW, boardH, 0.08), [back, back, back, back, face, back])
    board.position.set(ax * (boardX0 + boardW / 2), armY - 0.1, 0.16)
    grp.add(board)

    grp.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    root.add(grp)
  })
  return list.length
}

function octagonShape(r) {
  const shape = new THREE.Shape()
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4
    if (k === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r)
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r)
  }
  shape.closePath()
  return shape
}

/** Red octagon with white rim and a blurred legend (no readable text). */
function mandatoryFaceTexture() {
  const size = 256
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')
  const oct = (R, fill) => {
    g.beginPath()
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4
      const x = size / 2 + Math.cos(a) * R
      const y = size / 2 - Math.sin(a) * R
      if (k === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.closePath()
    g.fillStyle = fill
    g.fill()
  }
  oct(size / 2, '#ffffff')
  oct(size / 2 - 14, '#d61f26')
  g.save()
  if ('filter' in g) g.filter = 'blur(7px)'
  g.fillStyle = 'rgba(255,255,255,0.9)'
  g.beginPath()
  g.roundRect(size / 2 - 78, size / 2 - 26, 156, 52, 14)
  g.fill()
  g.restore()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

function stripedPostTexture() {
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 256
  const g = c.getContext('2d')
  const bands = 10
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 ? '#f4f4f4' : '#141414'
    g.fillRect(0, (i * c.height) / bands, c.width, c.height / bands)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/** Mandatory sign: red octagon plate on a black-and-white striped post with a black base plate. */
function addMandatorySigns(root, list, origin, medianPts) {
  if (!list?.length) return 0
  const r = 0.42
  const depth = 0.02
  const shape = octagonShape(r)

  const faceGeo = new THREE.ShapeGeometry(shape)
  const pos = faceGeo.attributes.position
  const uv = faceGeo.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / (2 * r) + 0.5, pos.getY(i) / (2 * r) + 0.5)
  }
  uv.needsUpdate = true
  faceGeo.translate(0, 0, depth + 0.002)
  const plateGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false })

  const postH = 2.3
  const faceMat = new THREE.MeshStandardMaterial({ map: mandatoryFaceTexture(), roughness: 0.45, metalness: 0.05 })
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.5 })
  const postMat = new THREE.MeshStandardMaterial({ map: stripedPostTexture(), roughness: 0.55, metalness: 0.1 })
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6, metalness: 0.2 })

  addInstancedKit(root, list.map((p) => placeSignBoard(p, origin, medianPts)), [
    { geo: new THREE.BoxGeometry(0.42, 0.05, 0.3), mat: baseMat, oy: 0.025 },
    { geo: new THREE.CylinderGeometry(0.035, 0.035, postH, 12), mat: postMat, oy: postH / 2 + 0.05 },
    { geo: plateGeo, mat: plateMat, oy: postH + 0.05, oz: 0.04 },
    { geo: faceGeo, mat: faceMat, oy: postH + 0.05, oz: 0.04 },
  ])
  return list.length
}

function addInventoryPoints(root, items, origin, medianPts) {
  if (!items?.length) return 0
  const byAsset = new Map()
  items.forEach((p) => {
    if (p.lat == null || p.lng == null) return
    const key = p.asset || p.name || 'Asset'
    if (!byAsset.has(key)) byAsset.set(key, [])
    byAsset.get(key).push(p)
  })
  let n = 0
  byAsset.forEach((list, asset) => {
    if (asset === 'Street Lights') {
      n += addStreetLights(root, list, origin, medianPts)
      return
    }
    if (asset === 'Trees') {
      n += addTrees(root, list, origin, medianPts)
      return
    }
    if (asset === 'Toll Plaza') {
      n += addTollPlazas(root, list, origin, medianPts)
      return
    }
    if (asset === 'Fuel Station') {
      n += addFuelStations(root, list, origin, medianPts)
      return
    }
    if (asset === 'Median Plants') {
      n += addMedianPlants(root, list, origin, medianPts)
      return
    }
    if (asset === 'Sign Boards') {
      const gantries = list.filter((p) => /gantry/i.test(p.sub || ''))
      const cantilevers = list.filter((p) => /cantilever/i.test(p.sub || ''))
      const mandatory = list.filter((p) => /mandatory/i.test(p.sub || ''))
      const boards = list.filter((p) => !/gantry|cantilever|mandatory/i.test(p.sub || ''))
      n += addGantrySigns(root, gantries, medianPts)
      n += addCantileverSigns(root, cantilevers, medianPts)
      n += addMandatorySigns(root, mandatory, origin, medianPts)
      if (boards.length) n += addRoadFurniture(root, boards, asset, origin, medianPts)
      return
    }
    n += addRoadFurniture(root, list, asset, origin, medianPts)
  })
  return n
}

function resamplePolyline(points, spacing = 2.1) {
  if (!points?.length) return []
  const out = [{ x: points[0].x, z: points[0].z }]
  let carry = 0
  for (let i = 1; i < points.length; i++) {
    let x0 = points[i - 1].x
    let z0 = points[i - 1].z
    const x1 = points[i].x
    const z1 = points[i].z
    let dx = x1 - x0
    let dz = z1 - z0
    let seg = Math.hypot(dx, dz)
    if (seg < 1e-4) continue
    while (carry + seg >= spacing) {
      const t = (spacing - carry) / seg
      x0 += dx * t
      z0 += dz * t
      out.push({ x: x0, z: z0 })
      dx = x1 - x0
      dz = z1 - z0
      seg = Math.hypot(dx, dz)
      carry = 0
    }
    carry += seg
  }
  const last = points[points.length - 1]
  const prev = out[out.length - 1]
  if (Math.hypot(last.x - prev.x, last.z - prev.z) > 0.4) out.push({ x: last.x, z: last.z })
  return out
}

function lineToLocalPoints(line, origin) {
  const latlngs = line.latlngs
  if (!latlngs?.length || latlngs.length < 2) return []
  const step = Math.max(1, Math.floor(latlngs.length / 600))
  const coords = []
  for (let i = 0; i < latlngs.length; i += step) {
    const [lat, lng] = latlngs[i]
    coords.push([lng, lat])
  }
  const last = latlngs[latlngs.length - 1]
  coords.push([last[1], last[0]])
  return projectToLocal(coords, origin).points
}

/** Outer asphalt edge (m from median): where inventory kerbs should sit. */
const KERB_EDGE_M =
  ROAD_SPEC.medianWidthM / 2 + ROAD_SPEC.laneWidthM * ROAD_SPEC.lanesIncreasing

/** Shoulder centre outside the white edge (shoulder width ≈ 1.7 m). Keep clear of asphalt. */
const BARRIER_EDGE_M = KERB_EDGE_M + 1.45

/** Infer −normal (Increasing / LHS) vs +normal (Decreasing / RHS) when `dir` is missing. */
function inferCorridorSideFromGps(points, medianPts) {
  if (!points?.length || !medianPts?.length) return 1
  let sum = 0
  const step = Math.max(1, Math.floor(points.length / 40))
  for (let i = 0; i < points.length; i += step) {
    const f = nearestMedianFrame(points[i], medianPts)
    sum += (points[i].x - f.x) * f.nx + (points[i].z - f.z) * f.nz
  }
  return sum >= 0 ? 1 : -1
}

function corridorSideSign(dir, points, medianPts) {
  const d = String(dir || '').toLowerCase()
  if (d.startsWith('inc') || d.startsWith('med')) return SIDE_LHS
  if (d.startsWith('dec')) return SIDE_RHS
  return inferCorridorSideFromGps(points, medianPts)
}

/** Project noisy GPS polyline onto a fixed offset from median (− = Increasing / LHS side). */
function snapLineToCorridorOffset(points, medianPts, dir, offsetM) {
  if (!points?.length || !medianPts?.length) return []
  const sign = corridorSideSign(dir, points, medianPts)
  const out = []
  let lastX = Infinity
  let lastZ = Infinity
  for (let i = 0; i < points.length; i++) {
    const f = nearestMedianFrame(points[i], medianPts)
    const x = f.x + f.nx * offsetM * sign
    const z = f.z + f.nz * offsetM * sign
    if (Math.hypot(x - lastX, z - lastZ) < 0.35) continue
    out.push({ x, z })
    lastX = x
    lastZ = z
  }
  return out
}

/** Light smoothing so posts/rails follow the road curve, not GPS jitter. */
function smoothPolyline2d(pts, passes = 2) {
  if (pts.length < 3) return pts
  let current = pts.map((p) => ({ x: p.x, z: p.z }))
  for (let pass = 0; pass < passes; pass++) {
    const next = [current[0]]
    for (let i = 1; i < current.length - 1; i++) {
      next.push({
        x: (current[i - 1].x + current[i].x + current[i + 1].x) / 3,
        z: (current[i - 1].z + current[i].z + current[i + 1].z) / 3,
      })
    }
    next.push(current[current.length - 1])
    current = next
  }
  return current
}

/** Dense shoulder polyline from chainage range — samples median tangent/normal every ~1.5 m. */
function shoulderLineFromChainage(medianPts, startKm, endKm, dir, offsetM, gpsHintPoints) {
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const { totalM } = polylineMetrics(medianPts)
  const d0 = ((Math.min(startKm, endKm) - CHAINAGE_MIN_KM) / span) * totalM
  const d1 = ((Math.max(startKm, endKm) - CHAINAGE_MIN_KM) / span) * totalM
  if (!(d1 > d0)) return []
  const sign = corridorSideSign(dir, gpsHintPoints, medianPts)
  const out = []
  const step = 1.5
  for (let d = d0; d < d1; d += step) {
    const s = sampleAtDistance(medianPts, d)
    out.push({
      x: s.x + s.nx * offsetM * sign,
      z: s.z + s.nz * offsetM * sign,
      tx: s.tx,
      tz: s.tz,
    })
  }
  const end = sampleAtDistance(medianPts, d1)
  out.push({
    x: end.x + end.nx * offsetM * sign,
    z: end.z + end.nz * offsetM * sign,
    tx: end.tx,
    tz: end.tz,
  })
  return out
}

/** Service road: 7 m two-lane strip beyond a grass verge outside the main shoulder. */
const SERVICE_ROAD_WIDTH_M = 7
const SERVICE_ROAD_CENTRE_M = KERB_EDGE_M + 1.7 + 6.5 + SERVICE_ROAD_WIDTH_M / 2
const SERVICE_SLIP_KM = 0.08
const SERVICE_SLIP_WIDTH_M = 5.5
const SERVICE_SEGMENTS = serviceRoadData.segments || NONE

/** Polyline along the median between two chainages with an offset that eases from offA to offB. */
function offsetLineFromChainage(medianPts, startKm, endKm, sign, offA, offB) {
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const { totalM } = polylineMetrics(medianPts)
  const d0 = ((Math.max(CHAINAGE_MIN_KM, startKm) - CHAINAGE_MIN_KM) / span) * totalM
  const d1 = ((Math.min(CHAINAGE_MAX_KM, endKm) - CHAINAGE_MIN_KM) / span) * totalM
  if (!(d1 > d0)) return []
  const out = []
  const push = (d) => {
    const s = sampleAtDistance(medianPts, d)
    const u = (d - d0) / (d1 - d0)
    const ease = u * u * (3 - 2 * u)
    const off = (offA + (offB - offA) * ease) * sign
    out.push({ x: s.x + s.nx * off, z: s.z + s.nz * off, tx: s.tx, tz: s.tz })
  }
  for (let d = d0; d < d1; d += 1.5) push(d)
  push(d1)
  return out
}

/**
 * Surface between two lateral offsets that may vary along the run. Offsets are
 * measured on the median normal (not the band's own bend), so tapering slip
 * roads keep clean edges instead of flaring on the curve.
 */
function corridorBandGeometry(medianPts, d0, d1, sign, edgesAt, y) {
  if (!(d1 > d0)) return null
  const ds = []
  for (let d = d0; d < d1; d += 1.5) ds.push(d)
  ds.push(d1)
  const n = ds.length
  const positions = new Float32Array(n * 6)
  const uvs = new Float32Array(n * 4)
  ds.forEach((d, i) => {
    const s = sampleAtDistance(medianPts, d)
    const [a, b] = edgesAt(d)
    positions.set([s.x + s.nx * a * sign, y, s.z + s.nz * a * sign, s.x + s.nx * b * sign, y, s.z + s.nz * b * sign], i * 6)
    uvs.set([0, (d - d0) * 0.05, 1, (d - d0) * 0.05], i * 4)
  })
  const indices = new Uint32Array((n - 1) * 6)
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    indices.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6)
  }
  return { positions, uvs, indices }
}

function addServiceRoads(root, segments, medianPts) {
  if (!segments?.length || !medianPts?.length) return 0
  const half = SERVICE_ROAD_WIDTH_M / 2
  const serviceInner = SERVICE_ROAD_CENTRE_M - half
  const asphaltMat = { map: asphaltMap(), roughness: 0.96, metalness: 0.02 }
  const markMat = { roughness: 0.42, metalness: 0.04 }
  const { totalM } = polylineMetrics(medianPts)
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const kmToD = (km) => Math.max(0, Math.min(totalM, ((km - CHAINAGE_MIN_KM) / span) * totalM))
  const smooth = (u) => {
    const t = Math.max(0, Math.min(1, u))
    return t * t * (3 - 2 * t)
  }
  const band = (d0, d1, sign, edgesAt, y, color, extra) => {
    const mesh = makeMesh(corridorBandGeometry(medianPts, d0, d1, sign, edgesAt, y), color, extra)
    if (mesh) root.add(mesh)
  }

  let n = 0
  segments.forEach((seg) => {
    const start = Number(seg.start)
    const end = Number(seg.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return
    const sign = corridorSideSign(seg.dir, null, medianPts)
    const dA = kmToD(start - SERVICE_SLIP_KM)
    const dS = kmToD(start)
    const dE = kmToD(end)
    const dB = kmToD(end + SERVICE_SLIP_KM)
    if (!(dB > dA)) return

    // 0 at the main carriageway edge (slip mouth) → 1 on the service road proper
    const blend = (d) => {
      if (d < dS && dS > dA) return smooth((d - dA) / (dS - dA))
      if (d > dE && dB > dE) return smooth((dB - d) / (dB - dE))
      return 1
    }
    const edges = (d) => {
      const e = blend(d)
      const inner = KERB_EDGE_M + (serviceInner - KERB_EDGE_M) * e
      const width = SERVICE_SLIP_WIDTH_M + (SERVICE_ROAD_WIDTH_M - SERVICE_SLIP_WIDTH_M) * e
      return [inner, inner + width]
    }
    const offset = (dIn, dOut) => (d) => {
      const [a, b] = edges(d)
      return [a + dIn, b + dOut]
    }

    band(dA, dB, sign, offset(-1, 1), 0.025, SHOULDER, { roughness: 0.98, metalness: 0 })
    band(dA, dB, sign, edges, 0.046, ASPHALT, asphaltMat)
    band(dA, dB, sign, (d) => { const [a] = edges(d); return [a + 0.15, a + 0.3] }, 0.053, MARK_WHITE, markMat)
    band(dA, dB, sign, (d) => { const [, b] = edges(d); return [b - 0.3, b - 0.15] }, 0.053, MARK_WHITE, markMat)

    const pts = offsetLineFromChainage(medianPts, start, end, sign, SERVICE_ROAD_CENTRE_M, SERVICE_ROAD_CENTRE_M)
    if (pts.length >= 2) addDashes(root, pts, -0.07, 0.07, 0.053, MARK_WHITE)
    n += 1
  })
  return n
}

/** Merge barrier inventory segments on the same side when chainage gap is small. */
function mergeBarrierRuns(lines, gapKm = 0.25) {
  const bySide = { Increasing: [], Decreasing: [], other: [] }
  lines.forEach((line) => {
    const d = String(line.dir || '')
    if (d.startsWith('Inc')) bySide.Increasing.push(line)
    else if (d.startsWith('Dec')) bySide.Decreasing.push(line)
    else bySide.other.push(line)
  })
  const runs = []
  ;['Increasing', 'Decreasing'].forEach((side) => {
    const arr = [...bySide[side]].sort((a, b) => Number(a.start) - Number(b.start))
    let cur = null
    arr.forEach((line) => {
      const s = Number(line.start)
      const e = Number(line.end)
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return
      if (!cur || s - cur.end > gapKm) {
        cur = { dir: side, start: s, end: e }
        runs.push(cur)
      } else {
        cur.end = Math.max(cur.end, e)
      }
    })
  })
  bySide.other.forEach((line) => runs.push(line))
  return runs
}

function barrierPathForRun(run, origin, medianPts, edgeM = BARRIER_EDGE_M) {
  const start = Number(run.start)
  const end = Number(run.end)
  if (medianPts?.length && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return shoulderLineFromChainage(medianPts, start, end, run.dir, edgeM, null)
  }
  const raw = lineToLocalPoints(run, origin)
  const snapped = snapLineToCorridorOffset(raw, medianPts, run.dir, edgeM)
  return resamplePolyline(smoothPolyline2d(snapped, 3), 1.8)
}

/** Project noisy GPS line onto corridor outer edge by dir (Inc = +normal, Dec = −normal). */
function snapLineToKerbEdge(points, medianPts, dir) {
  return snapLineToCorridorOffset(points, medianPts, dir, KERB_EDGE_M)
}

function addKerbs(root, lines, origin, medianPts) {
  if (!lines?.length) return 0
  let n = 0
  // Prefer chainage runs so kerbs also follow the corridor, not GPS zigzag
  const runs = mergeBarrierRuns(lines.map((l) => ({ ...l, dir: l.dir || 'Increasing' })))
  runs.forEach((run) => {
    const start = Number(run.start)
    const end = Number(run.end)
    let pts
    if (medianPts?.length && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      pts = shoulderLineFromChainage(medianPts, start, end, run.dir, KERB_EDGE_M, null)
    } else {
      const raw = lineToLocalPoints(run, origin)
      pts = resamplePolyline(snapLineToKerbEdge(raw, medianPts, run.dir), 2.0)
    }
    if (!pts || pts.length < 2) return
    addRibbon(root, pts, -0.16, 0.16, 0.22, KERB, { roughness: 0.62, metalness: 0.08 })
    addRibbon(root, pts, -0.2, 0.12, 0.3, 0xb8c0c8, { roughness: 0.7, metalness: 0.06 })
    n += 1
  })
  return n
}

/**
 * W-beam crash barrier on the shoulder only:
 * continuous ribbon rails (no lookAt zigzag) + posts every ~2.5 m.
 */
/** Open the main-road barrier where a service-road slip meets the carriageway. */
function cutRunsAtSlipMouths(runs) {
  const mouthKm = SERVICE_SLIP_KM * 0.6
  const gaps = SERVICE_SEGMENTS.flatMap((s) => {
    const side = String(s.dir || '').slice(0, 3).toLowerCase()
    const a = Number(s.start)
    const b = Number(s.end)
    return [
      { side, from: a - SERVICE_SLIP_KM - 0.005, to: a - SERVICE_SLIP_KM + mouthKm },
      { side, from: b + SERVICE_SLIP_KM - mouthKm, to: b + SERVICE_SLIP_KM + 0.005 },
    ]
  })
  let out = runs
  gaps.forEach((gap) => {
    out = out.flatMap((run) => {
      const side = String(run.dir || '').slice(0, 3).toLowerCase()
      const s = Number(run.start)
      const e = Number(run.end)
      if (side !== gap.side || e <= gap.from || s >= gap.to) return [run]
      const pieces = []
      if (gap.from - s > 0.005) pieces.push({ ...run, start: s, end: gap.from })
      if (e - gap.to > 0.005) pieces.push({ ...run, start: gap.to, end: e })
      return pieces
    })
  })
  return out
}

function addCrashBarriers(root, lines, origin, medianPts, edgeM = BARRIER_EDGE_M, gapKm = 0.25) {
  if (!lines?.length || !medianPts?.length) return 0
  const merged = mergeBarrierRuns(lines, gapKm)
  const runs = edgeM === BARRIER_EDGE_M ? cutRunsAtSlipMouths(merged) : merged
  const samples = []
  runs.forEach((run) => {
    const pts = barrierPathForRun(run, origin, medianPts, edgeM)
    if (pts.length >= 2) samples.push(pts)
  })
  if (!samples.length) return 0

  let postN = 0
  samples.forEach((pts) => {
    postN += Math.max(2, Math.ceil(pts.length / 2) + 1)
  })

  const steel = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 0.82, roughness: 0.24 })
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6e7682, metalness: 0.58, roughness: 0.36 })
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.95, 0.08), postMat, postN)
  const dummy = new THREE.Object3D()
  let pi = 0

  samples.forEach((pts) => {
    // Continuous rails as thin ribbons along the shoulder path (smooth on curves)
    ;[
      { y: 0.48, halfW: 0.035 },
      { y: 0.62, halfW: 0.04 },
      { y: 0.76, halfW: 0.035 },
    ].forEach(({ y, halfW }) => {
      const mesh = makeMesh(buildRibbonGeometry(pts, -halfW, halfW, y), 0xb8c0c8, {
        roughness: 0.28,
        metalness: 0.78,
      })
      if (mesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
        if (mesh.material) {
          mesh.material.color = steel.color
          mesh.material.metalness = 0.82
          mesh.material.roughness = 0.24
        }
        root.add(mesh)
      }
    })

    // Posts every other sample (~3 m) facing along the road tangent
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i]
      const tx = p.tx ?? (pts[Math.min(pts.length - 1, i + 1)].x - p.x)
      const tz = p.tz ?? (pts[Math.min(pts.length - 1, i + 1)].z - p.z)
      const yaw = Math.atan2(tx, tz)
      dummy.position.set(p.x, 0.48, p.z)
      dummy.rotation.set(0, yaw, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      posts.setMatrixAt(pi++, dummy.matrix)
    }
  })

  posts.count = pi
  posts.instanceMatrix.needsUpdate = true
  posts.castShadow = true
  root.add(posts)
  return samples.length
}

function addInventoryLines(root, lines, origin, medianPts) {
  if (!lines?.length) return 0
  const barriers = []
  const serviceBarriers = []
  const kerbs = []
  const other = []
  lines.forEach((line) => {
    const name = line.asset || line.name || ''
    if (/barrier/i.test(name)) (line.road === 'service' ? serviceBarriers : barriers).push(line)
    else if (/kerb/i.test(name)) kerbs.push(line)
    else other.push(line)
  })
  let n = addCrashBarriers(root, barriers, origin, medianPts)
  n += addCrashBarriers(root, serviceBarriers, origin, medianPts, sideOffsetM({ road: 'service' }, 0) - 0.3, 0.02)
  n += addKerbs(root, kerbs, origin, medianPts)
  other.forEach((line) => {
    const points = lineToLocalPoints(line, origin)
    if (points.length < 2) return
    const face = makeMesh(buildRibbonGeometry(points, -0.08, 0.08, 0.16), 0xd5dbe2, { roughness: 0.7, metalness: 0.08 })
    const top = makeMesh(buildRibbonGeometry(points, -0.22, 0.1, 0.28), 0xc2c8d0, { roughness: 0.65, metalness: 0.08 })
    if (face) root.add(face)
    if (top) root.add(top)
    n += 1
  })
  return n
}

/** Lat/lng on the median centreline at a chainage (km). */
function latLngAtKm(km) {
  const coords = medianData.coordinates || []
  if (coords.length < 2) return [22.65, 76.9]
  if (!latLngAtKm.cum) {
    const cum = [0]
    for (let i = 1; i < coords.length; i++) {
      const [lng0, lat0] = coords[i - 1]
      const [lng1, lat1] = coords[i]
      const dx = (lng1 - lng0) * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180) * 111320
      const dy = (lat1 - lat0) * 110540
      cum.push(cum[cum.length - 1] + Math.hypot(dx, dy))
    }
    latLngAtKm.cum = cum
  }
  const cum = latLngAtKm.cum
  const total = cum[cum.length - 1] || 1
  const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
  const d = Math.max(0, Math.min(((Number(km) - CHAINAGE_MIN_KM) / span) * total, total))
  let lo = 1
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < d) lo = mid + 1
    else hi = mid
  }
  const i1 = Math.max(1, lo)
  const i0 = i1 - 1
  const t = (d - cum[i0]) / (cum[i1] - cum[i0] || 1)
  const [lng0, lat0] = coords[i0]
  const [lng1, lat1] = coords[i1]
  return [lat0 + (lat1 - lat0) * t, lng0 + (lng1 - lng0) * t]
}

/** Small map of the corridor with a marker on the chainage the 3D view is showing. */
function CorridorLocationMap({ km, winStart, winEnd }) {
  const wrap = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const windowRef = useRef(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const line = (medianData.coordinates || []).map(([lng, lat]) => [lat, lng])
    const m = L.map(el, { zoomControl: false, attributionControl: false, scrollWheelZoom: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m)
    if (line.length > 1) {
      L.polyline(line, { color: '#f59e0b', weight: 4, opacity: 0.9 }).addTo(m)
    }
    const here = latLngAtKm(km)
    markerRef.current = L.circleMarker(here, {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#ef4444',
      fillOpacity: 1,
    }).addTo(m)
    m.setView(here, 14)
    mapRef.current = m
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el)
    const t = setTimeout(() => m.invalidateSize(), 150)
    return () => {
      clearTimeout(t)
      ro.disconnect()
      m.remove()
      mapRef.current = null
      markerRef.current = null
      windowRef.current = null
    }
    // Map is created once; chainage updates move the marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const m = mapRef.current
    const marker = markerRef.current
    if (!m || !marker) return
    const here = latLngAtKm(km)
    marker.setLatLng(here)
    if (windowRef.current) {
      m.removeLayer(windowRef.current)
      windowRef.current = null
    }
    if (Number.isFinite(winStart) && Number.isFinite(winEnd) && winEnd > winStart) {
      windowRef.current = L.polyline([latLngAtKm(winStart), latLngAtKm(winEnd)], {
        color: '#22d3ee',
        weight: 7,
        opacity: 0.95,
      }).addTo(m)
    }
    m.panTo(here, { animate: true, duration: 0.35 })
  }, [km, winStart, winEnd])

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <div ref={wrap} className="absolute inset-0" />
      <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded-lg bg-black/75 px-2 py-1 text-[11px] font-semibold text-white shadow">
        You are here · Ch {Number(km).toFixed(2)} km
      </div>
    </div>
  )
}

function IriTrendChart({ points, activeDate }) {
  if (!points?.length) return null
  const lanes = ['L1', 'L2']
  const colors = { L1: '#facc15', L2: '#38bdf8' }
  const w = 360
  const h = 92
  const pad = { l: 34, r: 8, t: 16, b: 18 }
  const maxY = Math.max(2800, ...points.flatMap((p) => lanes.map((lane) => (Number.isFinite(p[lane]) ? p[lane] * 1000 : 0))))
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const xAt = (i) => pad.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const yAt = (iri) => pad.t + (1 - (iri * 1000) / maxY) * innerH
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const label = (d) => `${months[Number(String(d).slice(5, 7)) - 1] || ''} ${String(d).slice(2, 4)}`
  const guide = (mm) => yAt(mm / 1000)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 block h-[92px] w-full" role="img" aria-label="IRI over survey dates">
      {[1800, 2400].map((mm) => (
        <g key={mm}>
          <line x1={pad.l} x2={w - pad.r} y1={guide(mm)} y2={guide(mm)} stroke="#334155" strokeDasharray="3 3" />
          <text x="2" y={guide(mm) + 3} fill="#64748b" fontSize="8">{mm}</text>
        </g>
      ))}
      {lanes.map((lane) => {
        const d = points
          .map((p, i) => (Number.isFinite(p[lane]) ? `${xAt(i).toFixed(1)},${yAt(p[lane]).toFixed(1)}` : null))
          .filter(Boolean)
        if (d.length < 2) return null
        return <path key={lane} d={`M${d.join('L')}`} fill="none" stroke={colors[lane]} strokeWidth="1.7" />
      })}
      {points.map((p, i) => lanes.map((lane) => (
        Number.isFinite(p[lane]) ? (
          <circle
            key={`${lane}-${p.date}`}
            cx={xAt(i)}
            cy={yAt(p[lane])}
            r={p.date === activeDate ? 3.4 : 2.1}
            fill={colors[lane]}
            stroke={p.date === activeDate ? '#ffffff' : 'none'}
            strokeWidth="1.2"
          />
        ) : null
      )))}
      {points.map((p, i) => (
        <text key={p.date} x={xAt(i)} y={h - 4} textAnchor="middle" fill={p.date === activeDate ? '#f8fafc' : '#94a3b8'} fontSize="8">
          {label(p.date)}
        </text>
      ))}
    </svg>
  )
}

function CountTrendChart({ points, color = '#38bdf8' }) {
  const rows = points || []
  if (rows.length < 2 || rows.every((p) => !p.n)) return null
  const w = 360
  const h = 46
  const pad = { l: 8, r: 8, t: 4, b: 14 }
  const maxN = Math.max(...rows.map((p) => p.n), 1)
  const innerW = w - pad.l - pad.r
  const gap = 4
  const barW = (innerW - gap * (rows.length - 1)) / rows.length
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const label = (d) => `${months[Number(String(d).slice(5, 7)) - 1] || ''} ${String(d).slice(2, 4)}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 block h-[46px] w-full" role="img" aria-label="Count over survey dates">
      {rows.map((p, i) => {
        const bh = Math.max(1, ((h - pad.t - pad.b) * p.n) / maxN)
        const x = pad.l + i * (barW + gap)
        const y = h - pad.b - bh
        return (
          <g key={p.date}>
            <rect x={x} y={y} width={barW} height={bh} rx="2" fill={color} opacity={p.n ? 0.9 : 0.25} />
            <text x={x + barW / 2} y={h - 3} textAnchor="middle" fill="#94a3b8" fontSize="8">{label(p.date)}</text>
          </g>
        )
      })}
    </svg>
  )
}

export default function NanasaRoad3DModal({
  open,
  onClose,
  inventoryPoints = NONE,
  inventoryLines = NONE,
  pavementRecords = NONE,
  pavementDate: pavementDateProp = '',
  initialChainageKm = null,
  initialPathMode = null,
  entryKey = 0,
}) {
  const host = useRef(null)
  const runtime = useRef(null)
  const reportedFilterRef = useRef('all')
  const predictedFilterRef = useRef('off')
  const invPoints = useMemo(() => inventoryPoints || NONE, [inventoryPoints])
  const invLines = useMemo(() => inventoryLines || NONE, [inventoryLines])

  const pmsDates = useMemo(() => {
    const fromFile = (pmsData.dates || []).filter(Boolean)
    if (fromFile.length) return fromFile
    const set = new Set()
    ;(pmsData.records || []).forEach((r) => {
      if (r.project === NANASA_PROJECT && r.date) set.add(r.date)
    })
    ;(pavementRecords || []).forEach((r) => {
      if (r.date) set.add(r.date)
    })
    return [...set].sort((a, b) => String(b).localeCompare(String(a)))
  }, [pavementRecords])

  const [pavementDate, setPavementDate] = useState(
    () => pavementDateProp || pmsData.dates?.[0] || '',
  )

  useEffect(() => {
    if (!open) return
    if (pavementDateProp && pavementDateProp !== pavementDate) {
      setPavementDate(pavementDateProp)
      return
    }
    if (pmsDates.length && pavementDate && !pmsDates.includes(pavementDate)) {
      setPavementDate(pmsDates[0])
    }
  }, [open, pavementDateProp, pmsDates]) // eslint-disable-line react-hooks/exhaustive-deps

  const pmsRecords = useMemo(() => {
    const all = (pmsData.records || []).filter((r) => r.project === NANASA_PROJECT)
    const source = all.length ? all : pavementRecords || NONE
    if (!pavementDate) return source
    return source.filter((r) => r.date === pavementDate)
  }, [pavementDate, pavementRecords])

  const reportedRecords = useMemo(
    () => (reportedData.records || []).filter((r) => r.project_name === NANASA_PROJECT),
    [],
  )
  const predictedRecords = useMemo(() => {
    const dates = predictedData.projects_dates?.[NANASA_PROJECT] || []
    const latest = dates[0]
    const all = (predictedData.records || []).filter(
      (r) => r.project_name === NANASA_PROJECT && (!latest || r.date === latest),
    )
    // Cap markers for FPS — keep spread along corridor
    const MAX = 400
    if (all.length <= MAX) return all
    const step = all.length / MAX
    const out = []
    for (let i = 0; i < MAX; i++) out.push(all[Math.floor(i * step)])
    return out
  }, [])
  const corridor = useMemo(() => projectToLocal(medianData.coordinates), [])
  // Full predicted set for the 10 m info panel (not FPS-capped)
  const predictedAll = useMemo(() => {
    const dates = predictedData.projects_dates?.[NANASA_PROJECT] || []
    const latest = dates[0]
    return (predictedData.records || []).filter(
      (r) => r.project_name === NANASA_PROJECT && (!latest || r.date === latest),
    )
  }, [])

  const [pathMode, setPathMode] = useState('lhs') // median | lhs | rhs
  const [showGraphs, setShowGraphs] = useState(false)
  const [scrubT, setScrubT] = useState(0) // 0..1 along selected path
  const [followScrubber, setFollowScrubber] = useState(true)
  const [pavementFilter, setPavementFilter] = useState('all') // all | off | good | fair | poor
  const [reportedFilter, setReportedFilter] = useState('all') // all | off | low | medium | high
  const [predictedFilter, setPredictedFilter] = useState('off') // off by default — heavy layer
  reportedFilterRef.current = reportedFilter
  predictedFilterRef.current = predictedFilter
  const [openLayerMenu, setOpenLayerMenu] = useState(null) // pavementDate | pavement | reported | predicted | null
  const [selectedReported, setSelectedReported] = useState(null)
  const [focusedDistress, setFocusedDistress] = useState(null)
  const [sceneLoading, setSceneLoading] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [chromeMode, setChromeMode] = useState('normal') // normal | fullscreen | minimized
  const [windowLengthM, setWindowLengthM] = useState(10) // cards + highlight patch length
  const shellRef = useRef(null)

  const playingRef = useRef(false)
  const scrubTRef = useRef(0)
  const pathModeRef = useRef('lhs')
  const followRef = useRef(true)
  const windowLengthRef = useRef(10)
  const scrubRef = useRef({
    mode: 'lhs',
    t: 0,
    chainageKm: CHAINAGE_MIN_KM,
    follow: true,
    camPos: new THREE.Vector3(),
    lookAt: new THREE.Vector3(),
    ready: false,
  })

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    scrubTRef.current = scrubT
  }, [scrubT])

  useEffect(() => {
    pathModeRef.current = pathMode
  }, [pathMode])

  useEffect(() => {
    followRef.current = followScrubber
  }, [followScrubber])

  useEffect(() => {
    windowLengthRef.current = windowLengthM
  }, [windowLengthM])

  // Jump to map drop / entry point when opened or re-dropped
  useEffect(() => {
    if (!open) return
    const mode = initialPathMode === 'lhs' || initialPathMode === 'rhs' || initialPathMode === 'median'
      ? initialPathMode
      : null
    if (mode) setPathMode(mode)
    if (Number.isFinite(Number(initialChainageKm))) {
      const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
      const km = Math.max(CHAINAGE_MIN_KM, Math.min(CHAINAGE_MAX_KM, Number(initialChainageKm)))
      const m = mode || pathModeRef.current || 'lhs'
      const t = m === 'rhs'
        ? (CHAINAGE_MAX_KM - km) / span
        : (km - CHAINAGE_MIN_KM) / span
      setScrubT(Math.max(0, Math.min(1, t)))
      setFollowScrubber(true)
      setPlaying(false)
    }
  }, [open, entryKey, initialChainageKm, initialPathMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) {
      setPlaying(false)
      setChromeMode('normal')
      setOpenLayerMenu(null)
      setSelectedReported(null)
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {})
      }
    }
  }, [open])

  const enterBrowserFullscreen = useCallback(async () => {
    const el = shellRef.current
    if (!el) {
      setChromeMode('fullscreen')
      return
    }
    try {
      if (el.requestFullscreen) await el.requestFullscreen()
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
      else if (el.msRequestFullscreen) await el.msRequestFullscreen()
      setChromeMode('fullscreen')
    } catch {
      setChromeMode('fullscreen')
    }
  }, [])

  const exitBrowserFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen()
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen()
      }
    } catch {
      /* ignore */
    }
    setChromeMode((m) => (m === 'fullscreen' ? 'normal' : m))
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (chromeMode === 'fullscreen' || document.fullscreenElement || document.webkitFullscreenElement) {
      exitBrowserFullscreen()
      return
    }
    enterBrowserFullscreen()
  }, [chromeMode, enterBrowserFullscreen, exitBrowserFullscreen])

  useEffect(() => {
    const onFsChange = () => {
      const active = !!(document.fullscreenElement || document.webkitFullscreenElement)
      setChromeMode((m) => {
        if (active) return 'fullscreen'
        if (m === 'fullscreen') return 'normal'
        return m
      })
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [])

  useEffect(() => {
    if (reportedFilter === 'off') setSelectedReported(null)
  }, [reportedFilter])

  useEffect(() => {
    applyPavementFilter(
      runtime.current?.pavementLayer,
      pavementFilter,
      runtime.current?.concreteLayer,
    )
  }, [pavementFilter])

  useEffect(() => {
    applyDistressFilter(runtime.current?.reportedLayer, reportedFilter)
  }, [reportedFilter])

  useEffect(() => {
    applyDistressFilter(runtime.current?.predictedLayer, predictedFilter)
  }, [predictedFilter])

  const scrubToChainage = useCallback((mode, t) => {
    const clamped = Math.max(0, Math.min(1, t))
    if (mode === 'rhs') {
      // RHS travels end → start as scrubber moves 0 → 1
      return CHAINAGE_MAX_KM - clamped * (CHAINAGE_MAX_KM - CHAINAGE_MIN_KM)
    }
    return CHAINAGE_MIN_KM + clamped * (CHAINAGE_MAX_KM - CHAINAGE_MIN_KM)
  }, [])

  const chainageSlice = useMemo(() => {
    const km = scrubToChainage(pathMode, scrubT)
    const { start: winStart, end: winEnd } = chainageWindow(km, windowLengthM)
    const want = pathModeSideSign(pathMode)
    const { points: medianPts, origin } = corridor

    // PMS rows: prefer `direction`, else resolve carriageway from survey GPS
    const pavement = pmsRecords.filter((r) => {
      if (!overlapsKm(r.start, r.end, winStart, winEnd)) return false
      if (!want) return true
      if (r.direction && matchesPathDir(r.direction, pathMode)) return true
      if (r.direction) return false
      const lat = r.from?.[0] != null && r.to?.[0] != null ? (r.from[0] + r.to[0]) / 2 : r.lat
      const lng = r.from?.[1] != null && r.to?.[1] != null ? (r.from[1] + r.to[1]) / 2 : r.lng
      const side = gpsSideSign(lat, lng, origin, medianPts)
      return !side || side === want
    })

    const matchesDistress = (r) => {
      if (!want) return true
      const d = String(r.direction || '').toLowerCase()
      if (d.startsWith('inc')) return want === SIDE_LHS
      if (d.startsWith('dec')) return want === SIDE_RHS
      const side = gpsSideSign(r.latitude, r.longitude, origin, medianPts)
      return !side || side === want
    }
    const reported = reportedRecords.filter(
      (r) =>
        overlapsKm(r.chainage_start, r.chainage_end ?? r.chainage_start, winStart, winEnd) &&
        matchesDistress(r),
    )
    const predicted = predictedAll.filter(
      (r) =>
        overlapsKm(r.chainage_start, r.chainage_end ?? r.chainage_start, winStart, winEnd) &&
        matchesDistress(r),
    )
    const invPts = invPoints.filter(
      (r) =>
        overlapsKm(r.start, r.end ?? r.start, winStart, winEnd) && matchesPathDir(r.dir, pathMode),
    )
    const invLn = invLines.filter(
      (r) => overlapsKm(r.start, r.end ?? r.start, winStart, winEnd) && matchesPathDir(r.dir, pathMode),
    )
    const invLabel = (r, fallback) =>
      `${r.asset || r.name || fallback}${r.road === 'service' ? ' · Service Rd' : ''}`
    const lineNames = [...new Set(invLn.map((r) => invLabel(r, 'Line')))]
    // 3D bridges barrier gaps (mergeBarrierRuns), so list barriers wherever a merged run is drawn
    const barrierLines = invLines.filter(
      (r) =>
        /barrier/i.test(r.asset || r.name || '') &&
        r.road !== 'service' &&
        matchesPathDir(r.dir, pathMode),
    )
    if (barrierLines.length && !lineNames.some((n) => /barrier/i.test(n) && !/service/i.test(n))) {
      const barrierName = barrierLines[0].asset || barrierLines[0].name || 'Crash Barrier'
      const drawn = mergeBarrierRuns(barrierLines).some((run) =>
        overlapsKm(run.start, run.end ?? run.start, winStart, winEnd),
      )
      if (drawn) lineNames.unshift(barrierName)
    }
    const onServiceRoad = SERVICE_SEGMENTS.some(
      (s) => matchesPathDir(s.dir, pathMode) && overlapsKm(s.start, s.end, winStart, winEnd),
    )
    if (onServiceRoad && !lineNames.includes('Service Road')) lineNames.push('Service Road')
    const pointGroups = {}
    invPts.forEach((r) => {
      const label = invLabel(r, 'Asset')
      const key = `${label}|${r.dir || ''}`
      if (!pointGroups[key]) {
        pointGroups[key] = { asset: label, dir: r.dir || '', count: 0 }
      }
      pointGroups[key].count += 1
    })
    return {
      km,
      winStart,
      winEnd,
      windowLengthM,
      pavement,
      reported,
      predicted,
      inventoryPoints: Object.values(pointGroups),
      inventoryLines: lineNames,
    }
  }, [
    pathMode,
    scrubT,
    windowLengthM,
    scrubToChainage,
    corridor,
    pmsRecords,
    reportedRecords,
    predictedAll,
    invPoints,
    invLines,
  ])

  const iriTrend = useMemo(() => {
    const dates = [...(pmsData.dates || [])].sort()
    const rows = (pmsData.records || []).filter((r) => {
      if (r.project !== NANASA_PROJECT) return false
      if (!overlapsKm(r.start, r.end, chainageSlice.winStart, chainageSlice.winEnd)) return false
      return matchesPathDir(r.direction, pathMode)
    })
    return dates
      .map((date) => {
        const point = { date }
        ;['L1', 'L2'].forEach((lane) => {
          const hit = rows.filter((r) => r.date === date && r.lane === lane && Number.isFinite(Number(r.iri)))
          point[lane] = hit.length ? hit.reduce((sum, r) => sum + Number(r.iri), 0) / hit.length : null
        })
        return point
      })
      .filter((p) => p.L1 != null || p.L2 != null)
  }, [chainageSlice.winStart, chainageSlice.winEnd, pathMode])

  const predictedIndex = useMemo(() => {
    if (!showGraphs) return null
    const index = new Map()
    ;(predictedData.records || []).forEach((r) => {
      if (r.project_name !== NANASA_PROJECT || !r.date) return
      const bin = Math.floor(Number(r.chainage_start) * 10)
      if (!Number.isFinite(bin)) return
      const dir = String(r.direction || '').toLowerCase().startsWith('dec') ? 'd' : 'i'
      const key = `${r.date}|${dir}|${bin}`
      index.set(key, (index.get(key) || 0) + 1)
    })
    return index
  }, [showGraphs])

  const predictedTrend = useMemo(() => {
    if (!predictedIndex) return []
    const dates = [...(predictedData.projects_dates?.[NANASA_PROJECT] || [])].sort()
    const startBin = Math.floor(chainageSlice.winStart * 10)
    const endBin = Math.floor((chainageSlice.winEnd - 1e-6) * 10)
    const dirs = pathMode === 'rhs' ? ['d'] : pathMode === 'lhs' ? ['i'] : ['i', 'd']
    return dates.map((date) => {
      let n = 0
      for (let bin = startBin; bin <= endBin; bin += 1) {
        dirs.forEach((dir) => {
          n += predictedIndex.get(`${date}|${dir}|${bin}`) || 0
        })
      }
      return { date, n }
    })
  }, [predictedIndex, chainageSlice.winStart, chainageSlice.winEnd, pathMode])

  const syncScrubTargets = useCallback((mode, t, follow) => {
    const rt = runtime.current
    const sr = scrubRef.current
    const chainageKm = scrubToChainage(mode, t)
    sr.mode = mode
    sr.t = t
    sr.chainageKm = chainageKm
    sr.follow = follow
    if (!rt?.points?.length) return

    const sample = sampleChainageShoulder(
      rt.points,
      chainageKm,
      CHAINAGE_MIN_KM,
      CHAINAGE_MAX_KM,
      mode,
      mode === 'median' ? 0 : SCRUBBER_SHOULDER_M,
    )
    // Camera rides the centre of the active carriageway (not median, not outer shoulder)
    const camSample = sampleChainageShoulder(
      rt.points,
      chainageKm,
      CHAINAGE_MIN_KM,
      CHAINAGE_MAX_KM,
      mode,
      mode === 'median' ? 0 : DISTRESS_LANE_M,
    )

    const markers = {
      lhs: rt.lhsMarker,
      rhs: rt.rhsMarker,
      median: rt.medMarker,
    }
    Object.entries(markers).forEach(([key, mk]) => {
      if (!mk) return
      mk.visible = key === mode
    })
    const active = markers[mode] || rt.medMarker
    if (active) {
      active.position.set(sample.x, 0, sample.z)
      active.rotation.y = sample.yaw
      active.visible = true
    }

    // Highlight the same chainage window shown in the info cards
    const lenM = windowLengthRef.current
    const win = chainageWindow(chainageKm, lenM)
    if (
      rt.chainageHighlight &&
      (sr._hlStart !== win.start || sr._hlEnd !== win.end || sr._hlMode !== mode || sr._hlLen !== lenM)
    ) {
      sr._hlStart = win.start
      sr._hlEnd = win.end
      sr._hlMode = mode
      sr._hlLen = lenM
      updateChainageHighlight(rt.chainageHighlight, rt.points, win.start, win.end, mode)
    }

    const backX = -Math.sin(camSample.yaw)
    const backZ = -Math.cos(camSample.yaw)
    sr.lookAt.set(camSample.x, 1.0, camSample.z)
    // Slightly lower chase — still readable, not ground-level
    sr.camPos.set(camSample.x + backX * 22, 5.0, camSample.z + backZ * 22)
    // Move sun less often — shadow map updates are expensive
    sr._sunTick = (sr._sunTick || 0) + 1
    if (rt.sun && (sr._sunTick % 8 === 0 || !sr.ready)) {
      rt.sun.position.set(sample.x + 45, 70, sample.z + 28)
      rt.sun.target.position.set(sample.x, 0, sample.z)
      rt.sun.target.updateMatrixWorld()
    }
    if (!sr.ready && rt.camera) {
      rt.camera.position.copy(sr.camPos)
      rt.controls.target.copy(sr.lookAt)
      rt.controls.update()
      sr.ready = true
    }
  }, [scrubToChainage])

  // Auto-advance scrubber: camera in RAF; React UI ~5 fps
  useEffect(() => {
    if (!open || !playing) return
    let raf = 0
    let last = performance.now()
    let uiAcc = 0
    const SPEED = 0.0025
    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      if (!playingRef.current) return
      const dt = Math.min(0.033, (now - last) / 1000)
      last = now
      let next = scrubTRef.current + SPEED * dt
      if (next >= 1) {
        playingRef.current = false
        setPlaying(false)
        scrubTRef.current = 1
        setScrubT(1)
        syncScrubTargets(pathModeRef.current, 1, followRef.current)
        return
      }
      scrubTRef.current = next
      syncScrubTargets(pathModeRef.current, next, followRef.current)
      uiAcc += dt
      if (uiAcc >= 0.2) {
        uiAcc = 0
        setScrubT(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, playing, syncScrubTargets])

  useEffect(() => {
    if (!open) return
    // While playing, RAF owns scrub sync — avoid double updates from scrubT state
    if (playingRef.current) return
    syncScrubTargets(pathMode, scrubT, followScrubber)
  }, [open, pathMode, scrubT, followScrubber, windowLengthM, syncScrubTargets])

  useEffect(() => {
    if (!open || !host.current) return
    setSceneLoading(true)

    const buildScene = () => {
    const el = host.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xb9cfe3)
    scene.fog = new THREE.Fog(0xb9cfe3, 800, 18000)

    const camera = new THREE.PerspectiveCamera(48, 1, 0.8, 120000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1))
    renderer.shadowMap.enabled = false
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.49

    const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x4d5c42, 0.95)
    scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff3dc, 1.35)
    sun.castShadow = false
    scene.add(sun)
    scene.add(sun.target)
    scene.add(new THREE.AmbientLight(0x9eb0c2, 0.28))

    const { points, origin } = corridor
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    points.forEach((p) => {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.z < minZ) minZ = p.z
      if (p.z > maxZ) maxZ = p.z
    })
    const span = Math.max(maxX - minX, maxZ - minZ, 2000) + 12000

    const turf = grassMap()
    turf.repeat.set(Math.max(80, span / 40), Math.max(80, span / 40))
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshStandardMaterial({ map: turf, color: 0x8aaa6c, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.set((minX + maxX) / 2, -0.06, (minZ + maxZ) / 2)
    ground.receiveShadow = true
    scene.add(ground)

    const root = new THREE.Group()
    addRealisticRoad(root, points)
    const concreteLayer = addConcretePavementSurfaces(root, points, origin, pmsRecords)
    const pavementLayer = addPavementIri(root, points, origin, pmsRecords)
    applyPavementFilter(pavementLayer, pavementFilter, concreteLayer)

    const lhsMarker = makeScrubberMarker(0x22c55e, new THREE.MeshStandardMaterial({ color: 0x166534 }))
    const rhsMarker = makeScrubberMarker(0x3b82f6, new THREE.MeshStandardMaterial({ color: 0x1d4ed8 }))
    const medMarker = makeScrubberMarker(0xf59e0b, new THREE.MeshStandardMaterial({ color: 0xb45309 }))
    const chainageHighlight = new THREE.Group()
    chainageHighlight.name = 'chainage10mHighlight'
    root.add(lhsMarker, rhsMarker, medMarker, chainageHighlight)

    runtime.current = {
      points,
      lhsMarker,
      rhsMarker,
      medMarker,
      chainageHighlight,
      concreteLayer,
      pavementLayer,
      reportedLayer: null,
      predictedLayer: null,
      controls,
      camera,
      sun,
    }
    scrubRef.current.ready = false
    scrubRef.current._hlStart = undefined
    scrubRef.current._hlEnd = undefined
    scrubRef.current._hlMode = undefined
    // Refs, not closure state: build runs two frames late, after the peg-drop entry jump
    syncScrubTargets(pathModeRef.current, scrubTRef.current, followRef.current)

    scene.add(root)

    controls.minDistance = 8
    controls.maxDistance = 60000
    controls.update()

    const resize = () => {
      const w0 = el.clientWidth || 1
      const h0 = el.clientHeight || 1
      camera.aspect = w0 / h0
      camera.updateProjectionMatrix()
      renderer.setSize(w0, h0, false)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let raf = 0
    let last = performance.now()
    let firstFrame = true
    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const sr = scrubRef.current
      if (sr.follow && sr.ready) {
        // Softer follow so play / scrub feels smooth, not snappy
        const alpha = 1 - Math.exp(-dt * 3.2)
        camera.position.lerp(sr.camPos, alpha)
        controls.target.lerp(sr.lookAt, alpha)
      }
      controls.update()
      renderer.render(scene, camera)
      if (firstFrame) {
        firstFrame = false
        setSceneLoading(false)
      }
    }
    tick(performance.now())

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let pointerDown = null
    const onPointerDown = (e) => {
      pointerDown = { x: e.clientX, y: e.clientY }
    }
    const onPointerUp = (e) => {
      if (!pointerDown) return
      const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y)
      pointerDown = null
      if (moved > 8) return
      const layer = runtime.current?.reportedLayer
      if (!layer?.visible) {
        setSelectedReported(null)
        return
      }
      const rect = renderer.domElement.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const pickables = []
      layer.traverse((obj) => {
        if (obj.isInstancedMesh && obj.userData?.pickable && obj.visible) pickables.push(obj)
      })
      const hits = raycaster.intersectObjects(pickables, false)
      if (!hits.length) {
        setSelectedReported(null)
        return
      }
      const hit = hits[0]
      const rec = hit.object.userData.records?.[hit.instanceId]
      setSelectedReported(rec || null)
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    const pending = []
    let alive = true
    const later = (fn) => {
      const id = requestAnimationFrame(() => {
        if (!alive || !runtime.current) return
        fn()
      })
      pending.push(id)
    }
    later(() => {
      const pmrem = new THREE.PMREMGenerator(renderer)
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture
      pmrem.dispose()
      const reportedLayer = addDistressLayer(root, reportedRecords, origin, points, 'reportedDistress', 1, true)
      applyDistressFilter(reportedLayer, reportedFilterRef.current)
      if (runtime.current) runtime.current.reportedLayer = reportedLayer
      later(() => {
        const predictedLayer = addDistressLayer(root, predictedRecords, origin, points, 'predictedDistress', 0.55, false)
        applyDistressFilter(predictedLayer, predictedFilterRef.current)
        if (runtime.current) runtime.current.predictedLayer = predictedLayer
        later(() => {
          addInventoryLines(root, invLines, origin, points)
          addServiceRoads(root, SERVICE_SEGMENTS, points)
          later(() => {
            addInventoryPoints(root, invPoints, origin, points)
          })
        })
      })
    })

    return () => {
      alive = false
      pending.forEach((id) => cancelAnimationFrame(id))
      runtime.current = null
      scrubRef.current.ready = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      renderer.dispose()
      if (scene.environment) scene.environment.dispose()
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          mats.forEach((m) => {
            if (m.map && !sharedTextures.has(m.map)) m.map.dispose()
            m.dispose()
          })
        }
      })
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement)
    }
    }

    // Heavy synchronous build — wait two frames so the loading overlay paints first
    let cancelled = false
    let dispose = null
    let rafB = 0
    const rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        if (cancelled || !host.current) return
        dispose = buildScene()
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(rafA)
      cancelAnimationFrame(rafB)
      dispose?.()
    }
  }, [open, corridor, invPoints, invLines, pmsRecords, reportedRecords, predictedRecords])

  if (!open) return null

  const fmtCh = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? `${Math.round(n)}` : n.toFixed(2))
  const currentKm = scrubToChainage(pathMode, scrubT)
  const pathLabel =
    pathMode === 'lhs' ? 'LHS · Increasing' : pathMode === 'rhs' ? 'RHS · Decreasing' : 'Median'
  const onPathChange = (mode) => {
    setPlaying(false)
    setPathMode(mode)
    setScrubT(0)
  }

  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (scrubT >= 0.999) setScrubT(0)
    setFollowScrubber(true)
    setPlaying(true)
  }

  /** Fly the chase camera to a distress record (card click). */
  const locateDistress = (rec, kind) => {
    const s = Number(rec?.chainage_start)
    if (!Number.isFinite(s)) return
    const e = Number(rec.chainage_end)
    const mid = Number.isFinite(e) && e > s ? (s + e) / 2 : s
    const km = Math.max(CHAINAGE_MIN_KM, Math.min(CHAINAGE_MAX_KM, mid))
    const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
    const t = pathMode === 'rhs' ? (CHAINAGE_MAX_KM - km) / span : (km - CHAINAGE_MIN_KM) / span
    setPlaying(false)
    setFollowScrubber(true)
    setScrubT(Math.max(0, Math.min(1, t)))
    setFocusedDistress(rec)
    if (kind === 'reported') {
      if (reportedFilter === 'off') setReportedFilter('all')
      setSelectedReported(rec)
    } else if (predictedFilter === 'off') {
      setPredictedFilter('all')
    }
  }

  /** Step along path by the selected window length. */
  const stepScrub = (dir) => {
    setPlaying(false)
    const span = CHAINAGE_MAX_KM - CHAINAGE_MIN_KM || 1
    const delta = (windowLengthM / 1000 / span) * dir
    setScrubT((t) => Math.max(0, Math.min(1, t + delta)))
  }

  const layerMenus = [
    pmsDates.length > 0 && {
      id: 'pavementDate',
      title: 'Pavement survey date',
      value: pavementDate,
      setValue: setPavementDate,
      labels: Object.fromEntries(pmsDates.map((d) => [d, formatSurveyDate(d)])),
      options: pmsDates.map((d) => ({
        id: d,
        label: formatSurveyDate(d),
        swatches: ['#34d399'],
      })),
    },
    pmsRecords.length > 0 && {
      id: 'pavement',
      title: 'Pavement layer',
      value: pavementFilter,
      setValue: setPavementFilter,
      labels: { off: 'Off', all: 'All (On)', good: 'Good only', fair: 'Fair only', poor: 'Poor only' },
      options: [
        { id: 'off', label: 'Off', swatches: [] },
        { id: 'all', label: 'All (On)', swatches: ['#111111', '#FACC15', '#F8FAFC'] },
        { id: 'good', label: 'IRI Good', swatches: ['#111111'] },
        { id: 'fair', label: 'IRI Fair', swatches: ['#FACC15'] },
        { id: 'poor', label: 'IRI Poor', swatches: ['#F8FAFC'] },
      ],
    },
    reportedRecords.length > 0 && {
      id: 'reported',
      title: 'Reported distress',
      value: reportedFilter,
      setValue: setReportedFilter,
      labels: { all: 'All (On)', low: 'Low', medium: 'Medium', high: 'High', off: 'Off' },
      options: [
        { id: 'all', label: 'All patches', swatches: ['#22c55e', '#FACC15', '#ef4444'] },
        { id: 'low', label: 'Low (patch)', swatches: ['#22c55e'] },
        { id: 'medium', label: 'Medium (patch)', swatches: ['#FACC15'] },
        { id: 'high', label: 'High (patch)', swatches: ['#ef4444'] },
        { id: 'off', label: 'Off', swatches: [] },
      ],
    },
    predictedRecords.length > 0 && {
      id: 'predicted',
      title: 'Predicted distress',
      value: predictedFilter,
      setValue: setPredictedFilter,
      labels: { all: 'All (On)', low: 'Low', medium: 'Medium', high: 'High', off: 'Off' },
      options: [
        { id: 'all', label: 'All pins', swatches: ['#38bdf8', '#a78bfa', '#f472b6'] },
        { id: 'low', label: 'Low (pin)', swatches: ['#38bdf8'] },
        { id: 'medium', label: 'Medium (pin)', swatches: ['#a78bfa'] },
        { id: 'high', label: 'High (pin)', swatches: ['#f472b6'] },
        { id: 'off', label: 'Off', swatches: [] },
      ],
    },
  ].filter(Boolean)

  const isFullscreen = chromeMode === 'fullscreen'
  const isMinimized = chromeMode === 'minimized'
  const shellClass = isFullscreen
    ? 'pointer-events-auto fixed inset-0 z-[2000] flex h-screen w-screen flex-col overflow-hidden rounded-none border-0 bg-[#0b1220] shadow-none'
    : isMinimized
      ? 'pointer-events-auto fixed bottom-3 right-3 z-[2000] flex h-[200px] w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-white/40 bg-[#0b1220] shadow-[0_20px_60px_rgba(15,23,42,0.55)]'
      : 'pointer-events-auto absolute inset-1 z-[1200] flex flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#0b1220]/40 shadow-[0_30px_80px_rgba(15,23,42,0.45)]'

  return (
    <div ref={shellRef} className={shellClass}>
      <div className="flex min-h-0 flex-1">
        <div className={`relative min-h-0 ${isMinimized ? 'w-full' : 'w-1/2'}`}>
        <div ref={host} className="absolute inset-0" />
        <div
          className={`pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#a8c6de] via-[#8fb3cf] to-[#4d7a4a] transition-opacity duration-500 ${sceneLoading ? 'opacity-100' : 'opacity-0'}`}
          aria-hidden={!sceneLoading}
        >
          <div className="relative h-16 w-16">
            <div className="absolute inset-0 rounded-full border-4 border-white/30" />
            <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-white" />
            <div className="absolute inset-3 flex items-center justify-center rounded-full bg-white/20 text-[11px] font-bold text-white">
              3D
            </div>
          </div>
          <div className="flex flex-col items-center gap-2 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
            <p className="m-0 text-[14px] font-semibold text-white">Building 3D road view…</p>
            <div className="h-1 w-40 overflow-hidden rounded-full bg-white/25">
              <div className="h-full w-1/3 animate-[road3dLoad_1.1s_ease-in-out_infinite] rounded-full bg-white" />
            </div>
          </div>
          <style>{'@keyframes road3dLoad{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
        </div>
        <div className="pointer-events-auto absolute right-2 top-2 z-30 flex items-center gap-1">
          {!isMinimized && (
            <button
              type="button"
              onClick={async () => {
                try {
                  if (document.fullscreenElement || document.webkitFullscreenElement) {
                    if (document.exitFullscreen) await document.exitFullscreen()
                    else if (document.webkitExitFullscreen) await document.webkitExitFullscreen()
                  }
                } catch {
                  /* ignore */
                }
                setChromeMode('minimized')
              }}
              title="Minimize"
              aria-label="Minimize"
              className="rounded-full border border-white/20 bg-black/55 px-2.5 py-1.5 text-[12px] font-semibold text-white backdrop-blur hover:bg-black/70"
            >
              −
            </button>
          )}
          {isMinimized && (
            <button
              type="button"
              onClick={() => setChromeMode('normal')}
              title="Restore"
              aria-label="Restore"
              className="rounded-full border border-white/20 bg-black/55 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur hover:bg-black/70"
            >
              Restore
            </button>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit full screen' : 'Full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur hover:bg-black/70"
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M9 3v6H3 M15 3v6h6 M9 21v-6H3 M15 21v-6h6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              if (document.fullscreenElement || document.webkitFullscreenElement) {
                exitBrowserFullscreen().finally(() => onClose())
              } else {
                onClose()
              }
            }}
            title="Close"
            aria-label="Close"
            className="rounded-full border border-white/20 bg-black/55 px-2.5 py-1.5 text-[12px] font-semibold text-white backdrop-blur hover:bg-black/70"
          >
            Close
          </button>
        </div>
        {isMinimized ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-8">
            <p className="m-0 text-[11px] font-semibold text-white">Nanasa 3D · Ch {chainageSlice.winStart.toFixed(2)} km</p>
          </div>
        ) : (
        <>
        <div className="pointer-events-none absolute left-1/2 top-10 z-20 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-transparent px-2 py-1.5 [text-shadow:0_1px_2px_rgba(0,0,0,0.95),0_0_6px_rgba(0,0,0,0.75)] sm:gap-2.5 sm:px-3 sm:py-2">
            <button
              type="button"
              onClick={() => stepScrub(-1)}
              title={`Back ${windowLengthM >= 1000 ? '1 km' : `${windowLengthM} m`}`}
              aria-label="Move chainage backward"
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/40 bg-white/10 text-white hover:bg-white/20"
            >
              <span aria-hidden className="text-[22px] leading-none">◀</span>
            </button>
            <div className="min-w-0 px-1 text-center sm:px-2">
              <p className="m-0 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-100 sm:text-[13px]">Chainage</p>
              <p className="m-0 text-[18px] font-semibold tabular-nums leading-tight text-white sm:text-[24px]">
                Ch {formatWindowKm(chainageSlice.winStart, windowLengthM)} – {formatWindowKm(chainageSlice.winEnd, windowLengthM)} km
              </p>
            </div>
            <label className="flex shrink-0 flex-col items-stretch gap-0.5">
              <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-100">Length</span>
              <select
                value={windowLengthM}
                onChange={(e) => setWindowLengthM(Number(e.target.value))}
                className="h-8 rounded-lg border border-white/50 bg-transparent px-1.5 text-[11px] font-semibold text-white outline-none hover:bg-white/10 [&>option]:bg-slate-900 [&>option]:text-white"
                title="Chainage window length for cards"
                aria-label="Chainage window length"
              >
                {WINDOW_LENGTH_OPTIONS.map((opt) => (
                  <option key={opt.m} value={opt.m} style={{ background: '#0f172a', color: '#fff' }}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => stepScrub(1)}
              title={`Forward ${windowLengthM >= 1000 ? '1 km' : `${windowLengthM} m`}`}
              aria-label="Move chainage forward"
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/40 bg-white/10 text-white hover:bg-white/20"
            >
              <span aria-hidden className="text-[22px] leading-none">▶</span>
            </button>
          </div>
        </div>
        {layerMenus.length > 0 && (
          <div className="pointer-events-auto absolute right-3 top-12 z-20 flex w-[min(210px,calc(100%-1.5rem))] flex-col gap-1.5">
            {layerMenus.map((menu) => {
              const isOpen = openLayerMenu === menu.id
              return (
                <div key={menu.id} className="relative">
                  <button
                    type="button"
                    onClick={() => setOpenLayerMenu(isOpen ? null : menu.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-xl border border-white/15 bg-black/60 px-2.5 py-2 text-left shadow-lg backdrop-blur hover:bg-black/70"
                    aria-expanded={isOpen}
                  >
                    <span>
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">{menu.title}</span>
                      <span className="text-[12px] font-semibold text-white">{menu.labels[menu.value] || menu.value}</span>
                    </span>
                    <span className={`text-[10px] text-slate-300 transition ${isOpen ? 'rotate-180' : ''}`} aria-hidden>
                      ▼
                    </span>
                  </button>
                  {isOpen && (
                    <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-white/15 bg-black/90 py-1 shadow-xl backdrop-blur">
                      {menu.options.map((opt) => {
                        const active = menu.value === opt.id
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              menu.setValue(opt.id)
                              setOpenLayerMenu(null)
                            }}
                            className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                              active ? 'bg-white/15 font-semibold text-white' : 'text-slate-200 hover:bg-white/10'
                            }`}
                          >
                            <span className="inline-flex items-center gap-1.5">
                              {opt.swatches.length ? (
                                <span className="inline-flex items-center gap-0.5">
                                  {opt.swatches.map((c) => (
                                    <i
                                      key={c}
                                      className="inline-block h-2.5 w-2.5 rounded-sm"
                                      style={{
                                        background: c,
                                        boxShadow:
                                          c === '#111111' || c === '#F8FAFC'
                                            ? 'inset 0 0 0 1px rgba(148,163,184,0.75)'
                                            : undefined,
                                      }}
                                    />
                                  ))}
                                </span>
                              ) : (
                                <i className="inline-block h-2.5 w-2.5 rounded-sm border border-white/30 bg-transparent" />
                              )}
                              {opt.label}
                            </span>
                            {active && <span className="text-[10px] text-emerald-400">●</span>}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-end gap-1.5 p-2">
          <div className="pointer-events-auto flex w-full items-center gap-2 rounded-xl border border-white/15 bg-[#0f172a]/90 px-2.5 py-1.5 shadow-xl backdrop-blur sm:gap-3 sm:px-3 sm:py-2">
            <select
              value={pathMode}
              onChange={(e) => onPathChange(e.target.value)}
              className="h-8 shrink-0 rounded-lg border border-white/15 bg-white/10 px-2 text-[12px] font-semibold text-white outline-none [&>option]:bg-slate-900 [&>option]:text-white"
              title="Path"
            >
              <option value="median" style={{ background: '#0f172a', color: '#fff' }}>Median</option>
              <option value="lhs" style={{ background: '#0f172a', color: '#fff' }}>LHS</option>
              <option value="rhs" style={{ background: '#0f172a', color: '#fff' }}>RHS</option>
            </select>
            <div className="inline-flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => stepScrub(-1)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-white hover:bg-white/20"
                title={`Back ${windowLengthM >= 1000 ? '1 km' : `${windowLengthM} m`}`}
                aria-label="Move backward"
              >
                <span aria-hidden className="text-[13px] leading-none">◀</span>
              </button>
              <button
                type="button"
                onClick={togglePlay}
                className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[12px] font-semibold ${playing ? 'bg-amber-500 text-white' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <>
                    <span aria-hidden>❚❚</span> Pause
                  </>
                ) : (
                  <>
                    <span aria-hidden>▶</span> Play
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => stepScrub(1)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-white hover:bg-white/20"
                title={`Forward ${windowLengthM >= 1000 ? '1 km' : `${windowLengthM} m`}`}
                aria-label="Move forward"
              >
                <span aria-hidden className="text-[13px] leading-none">▶</span>
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 grid grid-cols-3 items-center gap-2 text-[11px]">
                <span className={`font-medium ${pathMode === 'lhs' ? 'text-emerald-400' : pathMode === 'rhs' ? 'text-blue-400' : 'text-amber-400'}`}>
                  {pathLabel}
                </span>
                <span className="text-center tabular-nums font-semibold text-white">
                  Ch {fmtCh(currentKm)} km
                </span>
                <span />
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.0005}
                value={scrubT}
                onChange={(e) => {
                  setPlaying(false)
                  setScrubT(Number(e.target.value))
                }}
                className={`h-1.5 w-full cursor-pointer ${pathMode === 'lhs' ? 'accent-emerald-500' : pathMode === 'rhs' ? 'accent-blue-500' : 'accent-amber-500'}`}
              />
              <div className="mt-0.5 flex justify-between text-[9px] text-slate-500">
                <span>{pathMode === 'rhs' ? CHAINAGE_MAX_KM : CHAINAGE_MIN_KM} km</span>
                <span>{pathMode === 'rhs' ? CHAINAGE_MIN_KM : CHAINAGE_MAX_KM} km</span>
              </div>
            </div>
            <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-slate-300">
              <input type="checkbox" checked={followScrubber} onChange={(e) => setFollowScrubber(e.target.checked)} className="accent-indigo-500" />
              Follow
            </label>
          </div>
        </div>
        </>
        )}
        </div>
        {!isMinimized && (
          <div className="flex min-h-0 w-1/2 min-w-0 flex-col border-l border-white/10 bg-[#0b1220]">
            <div className="relative z-0 h-[42%] shrink-0 overflow-hidden">
              <CorridorLocationMap km={currentKm} winStart={chainageSlice.winStart} winEnd={chainageSlice.winEnd} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden border-t border-white/10 p-2">
              <button
                type="button"
                onClick={() => setShowGraphs((on) => !on)}
                className="shrink-0 self-start rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[12px] font-semibold text-white hover:bg-white/20"
              >
                {showGraphs ? 'Hide graphs' : 'View graphs'}
              </button>
              {/* Pavement */}
              <div className="shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-2">
                <div className="mb-1.5 flex shrink-0 items-center gap-1.5">
                  <span className="text-emerald-300" aria-hidden>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 19V9 M10 19V5 M16 19v-7 M22 19V7" />
                    </svg>
                  </span>
                  <p className="m-0 min-w-0 flex-1 truncate text-[12px] font-bold uppercase tracking-[0.1em] text-emerald-300">
                    Pavement score
                  </p>
                  {chainageSlice.pavement.length > 0 && (
                    <span className="shrink-0 rounded-full bg-black/40 px-1.5 text-[10px] font-bold text-white [text-shadow:none]">
                      {chainageSlice.pavement.length}
                    </span>
                  )}
                </div>
                {chainageSlice.pavement.length === 0 ? (
                  <p className="m-0 truncate px-1 text-[12px] text-slate-300">No PMS data for this bin</p>
                ) : (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 overflow-hidden">
                    {chainageSlice.pavement.map((r, i) => {
                      const band = iriBand(r)
                      return (
                        <div key={`pms-${r.i ?? i}`} className="shrink-0 rounded-xl bg-transparent px-2 py-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[15px] font-semibold capitalize text-white">
                              {r.pavement || '—'}
                              {r.lane ? <span className="ml-1.5 text-[12px] font-medium normal-case text-slate-200">{r.direction ? `${r.direction.slice(0, 3)} · ` : ''}{r.lane}</span> : null}
                            </span>
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold [text-shadow:none]"
                              style={{
                                background:
                                  band === 'good' ? '#111111' : band === 'fair' ? '#eab308' : band === 'poor' ? '#e2e8f0' : '#64748b',
                                color: band === 'poor' || band === 'fair' ? '#0f172a' : '#f8fafc',
                              }}
                            >
                              {iriBandLabel(band)}
                            </span>
                          </div>
                          <p className="mb-0 mt-0.5 truncate text-[12px] font-medium text-slate-100">
                            IRI {Number.isFinite(Number(r.iri)) ? Math.round(Number(r.iri) * 1000) : '—'} mm/km
                            {r.pcs ? ` • PCS ${r.pcs}` : ''}
                          </p>
                          {r.iriStatus ? (
                            <p className="mb-0 mt-0.5 line-clamp-1 text-[11px] leading-snug text-slate-200">{r.iriStatus}</p>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}
                {showGraphs && iriTrend.length > 1 && (
                  <div className="mt-1 border-t border-white/10 pt-1">
                    <div className="flex items-center gap-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      <span>IRI over surveys</span>
                      <span className="inline-flex items-center gap-1 normal-case tracking-normal text-slate-300"><i className="inline-block h-1.5 w-3 rounded-sm bg-[#facc15]" />L1</span>
                      <span className="inline-flex items-center gap-1 normal-case tracking-normal text-slate-300"><i className="inline-block h-1.5 w-3 rounded-sm bg-[#38bdf8]" />L2</span>
                    </div>
                    <IriTrendChart points={iriTrend} activeDate={pavementDate} />
                  </div>
                )}
              </div>

              {/* Reported */}
              <div className="shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-2">
                <div className="mb-1.5 flex shrink-0 items-center gap-1.5">
                  <span className="text-amber-300" aria-hidden>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 3 L22 20 H2 Z" />
                      <path d="M12 9 v5 M12 17 h.01" />
                    </svg>
                  </span>
                  <p className="m-0 min-w-0 flex-1 truncate text-[12px] font-bold uppercase tracking-[0.1em] text-amber-300">
                    Reported distress
                  </p>
                  {chainageSlice.reported.length > 0 && (
                    <span className="shrink-0 rounded-full bg-black/40 px-1.5 text-[10px] font-bold text-white [text-shadow:none]">
                      {chainageSlice.reported.length}
                    </span>
                  )}
                </div>
                {chainageSlice.reported.length === 0 ? (
                  <p className="m-0 truncate px-1 text-[12px] text-slate-300">No distress reported · Looks good!</p>
                ) : (
                  <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 overflow-hidden">
                    {chainageSlice.reported.map((r, i) => (
                      <button
                        type="button"
                        key={`rep-${i}`}
                        onClick={() => locateDistress(r, 'reported')}
                        title="Locate in 3D"
                        className={`flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left transition hover:bg-white/15 ${focusedDistress === r ? 'bg-white/20 ring-1 ring-amber-300/80' : 'bg-transparent'}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
                          {r.distress_type || 'Distress'}
                          <span className="ml-1.5 text-[11px] font-medium text-amber-200">
                            {String(r.direction || '').toLowerCase().startsWith('dec') ? '↘' : '↗'} {r.direction || '—'}
                            {r.area != null ? ` · ${Number(r.area).toFixed(1)} m²` : ''}
                            {Number.isFinite(Number(r.chainage_start)) ? ` · Ch ${Number(r.chainage_start).toFixed(3)}` : ''}
                          </span>
                        </span>
                          <span
                            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold text-slate-900 [text-shadow:none]"
                            style={{
                              background:
                                r.severity === 'High' ? '#ef4444' : r.severity === 'Medium' ? '#eab308' : '#16a34a',
                              color: r.severity === 'Medium' ? '#0f172a' : '#fff',
                            }}
                          >
                            {r.severity || 'Low'}
                          </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Predicted */}
              <div className="shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-2">
                <div className="mb-1.5 flex shrink-0 items-center gap-1.5">
                  <span className="text-cyan-300" aria-hidden>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 17 L9 11 L13 15 L21 6" />
                      <path d="M16 6 h5 v5" />
                    </svg>
                  </span>
                  <p className="m-0 min-w-0 flex-1 truncate text-[12px] font-bold uppercase tracking-[0.1em] text-cyan-300">
                    Predicted distress
                  </p>
                  {chainageSlice.predicted.length > 0 && (
                    <span className="shrink-0 rounded-full bg-black/40 px-1.5 text-[10px] font-bold text-white [text-shadow:none]">
                      {chainageSlice.predicted.length}
                    </span>
                  )}
                </div>
                {chainageSlice.predicted.length === 0 ? (
                  <p className="m-0 truncate px-1 text-[12px] text-slate-300">No prediction for this bin</p>
                ) : (
                  <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 overflow-hidden">
                    {chainageSlice.predicted.map((r, i) => (
                      <button
                        type="button"
                        key={`pred-${i}`}
                        onClick={() => locateDistress(r, 'predicted')}
                        title="Locate in 3D"
                        className={`flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left transition hover:bg-white/15 ${focusedDistress === r ? 'bg-white/20 ring-1 ring-cyan-300/80' : 'bg-transparent'}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
                          {r.distress_type || 'Distress'}
                          <span className="ml-1.5 text-[11px] font-medium text-cyan-200">
                            {String(r.direction || '').toLowerCase().startsWith('dec') ? '↘' : '↗'} {r.direction || '—'}
                            {Number.isFinite(Number(r.chainage_start)) ? ` · Ch ${Number(r.chainage_start).toFixed(3)}` : ''}
                          </span>
                        </span>
                          <span
                            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold text-slate-900 [text-shadow:none]"
                            style={{
                              background:
                                r.severity === 'High' ? '#f472b6' : r.severity === 'Medium' ? '#a78bfa' : '#38bdf8',
                            }}
                          >
                            {r.severity || 'Low'}
                          </span>
                      </button>
                    ))}
                  </div>
                )}
                {showGraphs && <CountTrendChart points={predictedTrend} color="#38bdf8" />}
              </div>
              <div className="shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-2">
                <div className="mb-1.5 flex shrink-0 items-center gap-1.5">
                  <span className="text-fuchsia-300" aria-hidden>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 3 L21 8 L12 13 L3 8 Z" />
                      <path d="M3 8 v8 l9 5 M21 8 v8 l-9 5 M12 13 v8" />
                    </svg>
                  </span>
                  <p className="m-0 min-w-0 flex-1 truncate text-[12px] font-bold uppercase tracking-[0.1em] text-fuchsia-300">
                    Inventory
                  </p>
                  {chainageSlice.inventoryPoints.length + chainageSlice.inventoryLines.length > 0 && (
                    <span className="shrink-0 rounded-full bg-black/40 px-1.5 text-[10px] font-bold text-white [text-shadow:none]">
                      {chainageSlice.inventoryPoints.length + chainageSlice.inventoryLines.length}
                    </span>
                  )}
                </div>
                {chainageSlice.inventoryPoints.length === 0 && chainageSlice.inventoryLines.length === 0 ? (
                  <p className="m-0 truncate px-1 text-[12px] text-slate-300">No inventory in this bin</p>
                ) : (
                  <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 overflow-hidden">
                    {[
                      ...chainageSlice.inventoryLines.map((name) => ({
                        key: `line-${name}`,
                        title: name,
                        badge: 'Linear',
                        sub: 'Covers this chainage',
                      })),
                      ...chainageSlice.inventoryPoints.map((g) => ({
                        key: `pt-${g.asset}-${g.dir}`,
                        title: g.asset,
                        badge: `×${g.count}`,
                        sub: g.dir || 'Point asset',
                      })),
                    ]
                      .map((item) => (
                        <div key={item.key} className="flex min-w-0 items-center gap-1.5 px-1.5 py-0.5">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
                            {item.title}
                            <span className="ml-1.5 text-[11px] font-medium text-slate-300">{item.sub}</span>
                          </span>
                          <span className="shrink-0 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white">{item.badge}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
          {selectedReported && (
            <div className="pointer-events-auto shrink-0 overflow-hidden rounded-xl border border-white/15 bg-black/75 p-2 shadow-xl">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <p className="m-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Reported distress</p>
                  <h3 className="m-0 text-[15px] font-semibold text-white">{selectedReported.distress_type || 'Distress'}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedReported(null)}
                  className="rounded-md px-1.5 py-0.5 text-[12px] text-slate-300 hover:bg-white/10 hover:text-white"
                  title="Close"
                >
                  ✕
                </button>
              </div>
              <div className="mb-2">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                  style={{
                    background:
                      selectedReported.severity === 'High'
                        ? '#ef4444'
                        : selectedReported.severity === 'Medium'
                          ? '#ca8a04'
                          : '#16a34a',
                  }}
                >
                  {selectedReported.severity || 'Low'}
                </span>
              </div>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                {[
                  ['Chainage', `${selectedReported.chainage_start ?? '—'} – ${selectedReported.chainage_end ?? '—'} km`],
                  ['Direction', selectedReported.direction || '—'],
                  ['Pavement', selectedReported.pavement_type || '—'],
                  ['Lane', selectedReported.lane || '—'],
                  ['Area', selectedReported.area != null ? `${Number(selectedReported.area).toFixed(2)} m²` : '—'],
                  ['Length', selectedReported.length != null ? `${Number(selectedReported.length).toFixed(2)} m` : '—'],
                  ['Width', selectedReported.width != null ? `${Number(selectedReported.width).toFixed(2)} m` : '—'],
                  ['Depth', selectedReported.depth != null ? `${Number(selectedReported.depth)}` : '—'],
                  ['Date', selectedReported.date || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-400">{k}</dt>
                    <dd className="m-0 font-medium text-slate-100">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
