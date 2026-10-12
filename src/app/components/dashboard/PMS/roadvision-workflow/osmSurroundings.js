import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { lngLatToLocal } from './road3dGeometry'
import surroundingsData from '../../../../../assets/data/nanasa-surroundings.json'

const CORRIDOR_M = 200
const ROAD_CLEAR_M = 12

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
  if (/tower|mast|chimney|pole/.test(kind)) return 'tower'
  if (/tank|silo|water_tower|reservoir/.test(kind)) return 'tank'
  return 'box'
}

function insideCorridor(lng, lat, origin, line) {
  const loc = lngLatToLocal(lng, lat, origin)
  const d = distToLine(loc.x, loc.z, line)
  return d >= ROAD_CLEAR_M && d <= CORRIDOR_M
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
    return { id: row.id, kind: 'building', ring: row.ring, at: centroid(row.ring), height, estimated }
  }
  if (row.kind === 'tree') {
    return { id: row.id, kind: 'tree', at: row.at, height: parseMeters(tags.height) || 6 }
  }
  const made = tags.man_made || 'tower'
  return {
    id: row.id,
    kind: 'structure',
    at: row.at,
    height: parseMeters(tags.height) || (structureForm(made) === 'tower' ? 12 : 6),
    form: structureForm(made),
  }
})

export function loadSurroundings(coords, origin) {
  const line = coords.map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
  const features = STORED.filter((feature) => feature.at && insideCorridor(feature.at[0], feature.at[1], origin, line))
  return Promise.resolve(features)
}

function buildingGeometry(feature, origin) {
  const pts = feature.ring.map(([lng, lat]) => lngLatToLocal(lng, lat, origin))
  if (pts.length < 4) return null
  const shape = new THREE.Shape()
  shape.moveTo(pts[0].x, -pts[0].z)
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: feature.height, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, 0.08, 0)
  return geo
}

function addBuildings(group, features, origin, estimated) {
  const geoms = []
  features.forEach((feature) => {
    if (feature.kind !== 'building' || feature.estimated !== estimated) return
    try {
      const geo = buildingGeometry(feature, origin)
      if (geo) geoms.push(geo)
    } catch {
      /* skip a broken footprint */
    }
  })
  if (!geoms.length) return 0
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
  if (geoms.length > 1) geoms.forEach((geo) => geo.dispose())
  if (!merged) return 0
  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({
      color: estimated ? 0xd7c4a4 : 0xb7b3ac,
      roughness: 0.92,
      metalness: 0.02,
    }),
  )
  mesh.name = estimated ? 'osmBuildingsEstimated' : 'osmBuildings'
  group.add(mesh)
  return features.filter((feature) => feature.kind === 'building' && feature.estimated === estimated).length
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

function addStructures(group, features, origin) {
  const items = features.filter((feature) => feature.kind === 'structure')
  if (!items.length) return 0
  const byForm = { tower: [], tank: [], box: [] }
  items.forEach((item) => byForm[item.form || 'box'].push(item))
  const specs = {
    tower: () => new THREE.CylinderGeometry(0.35, 0.55, 1, 8),
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
  return items.length
}

export function createSurroundingsGroup(features, origin) {
  const group = new THREE.Group()
  group.name = 'osmSurroundings'
  const buildings = addBuildings(group, features, origin, false)
  const estimated = addBuildings(group, features, origin, true)
  const trees = addTrees(group, features, origin)
  const structures = addStructures(group, features, origin)
  group.userData.counts = {
    buildings: buildings + estimated,
    trees,
    structures,
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
