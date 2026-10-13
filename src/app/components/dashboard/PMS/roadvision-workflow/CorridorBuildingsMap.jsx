import { useEffect, useRef } from 'react'
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import buildings from '../../../../../assets/data/nanasa-buildings.json'
import medianData from '../../../../../assets/data/nanasa-median.json'

setWorkerUrl(workerUrl)

/** Esri imagery sends the headers a WebGL map needs. Google tiles work in Leaflet, not here. */
const SATELLITE = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
]
const BASEMAPS = {
  satellite: {
    tiles: SATELLITE,
    attribution: 'Tiles © Esri',
  },
  osm: {
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors',
  },
}
const COLOR_ZOOM = 18

function applyRaster(map, basemap) {
  const spec = BASEMAPS[basemap] || BASEMAPS.satellite
  if (map.getLayer('sat')) map.removeLayer('sat')
  if (map.getSource('sat')) map.removeSource('sat')
  map.addSource('sat', {
    type: 'raster',
    tiles: spec.tiles,
    tileSize: 256,
    maxzoom: 19,
    attribution: spec.attribution,
  })
  const before = map.getLayer('building-walls') ? 'building-walls' : undefined
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat' }, before)
}

/**
 * Drop any footprint that reaches the road.
 * The carriageway is 10.5 m from the centreline (median, two lanes, shoulder).
 * OpenStreetMap draws that highway wider, and some footprints sit a few metres
 * off the survey line, so the clear strip is 24 m each side. Houses beyond it stay.
 */
const ROAD_CLEAR_M = 24
const M_PER_DEG_LAT = 110540
const M_PER_DEG_LNG = 111320 * Math.cos((22.5 * Math.PI) / 180)
const SEG_CELL_M = 80

function toLocal(lng, lat) {
  return [(lng - 76.9) * M_PER_DEG_LNG, (lat - 22.5) * M_PER_DEG_LAT]
}

function medianIndex(coords) {
  const segs = []
  const grid = Object.create(null)
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = toLocal(coords[i - 1][0], coords[i - 1][1])
    const [x2, y2] = toLocal(coords[i][0], coords[i][1])
    const seg = { x1, y1, x2, y2 }
    const id = segs.length
    segs.push(seg)
    const x0 = Math.floor((Math.min(x1, x2) - ROAD_CLEAR_M) / SEG_CELL_M)
    const x1c = Math.floor((Math.max(x1, x2) + ROAD_CLEAR_M) / SEG_CELL_M)
    const y0 = Math.floor((Math.min(y1, y2) - ROAD_CLEAR_M) / SEG_CELL_M)
    const y1c = Math.floor((Math.max(y1, y2) + ROAD_CLEAR_M) / SEG_CELL_M)
    for (let cx = x0; cx <= x1c; cx++) {
      for (let cy = y0; cy <= y1c; cy++) {
        const key = `${cx}:${cy}`
        if (!grid[key]) grid[key] = []
        grid[key].push(id)
      }
    }
  }
  return { segs, grid }
}

function dist2PointSeg(px, py, seg) {
  const abx = seg.x2 - seg.x1
  const aby = seg.y2 - seg.y1
  const ab2 = abx * abx + aby * aby
  let t = ab2 > 0 ? ((px - seg.x1) * abx + (py - seg.y1) * aby) / ab2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const dx = px - (seg.x1 + abx * t)
  const dy = py - (seg.y1 + aby * t)
  return dx * dx + dy * dy
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax
  const ry = by - ay
  const sx = dx - cx
  const sy = dy - cy
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-8) return false
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

const medianLookup = medianIndex(medianData.coordinates || [])
const CLEAR2 = ROAD_CLEAR_M * ROAD_CLEAR_M

function onPavedRoad(feature) {
  const ring = feature?.geometry?.coordinates?.[0]
  if (!ring || ring.length < 3) return false
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length
  const xy = []
  for (let i = 0; i < n; i++) xy.push(toLocal(ring[i][0], ring[i][1]))
  for (let i = 0; i < xy.length; i++) {
    const [x, y] = xy[i]
    const [x2, y2] = xy[(i + 1) % xy.length]
    const cx = Math.floor(x / SEG_CELL_M)
    const cy = Math.floor(y / SEG_CELL_M)
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const list = medianLookup.grid[`${gx}:${gy}`]
        if (!list) continue
        for (let k = 0; k < list.length; k++) {
          const seg = medianLookup.segs[list[k]]
          if (dist2PointSeg(x, y, seg) <= CLEAR2) return true
          if (dist2PointSeg(x + (x2 - x) / 3, y + (y2 - y) / 3, seg) <= CLEAR2) return true
          if (dist2PointSeg(x + (2 * (x2 - x)) / 3, y + (2 * (y2 - y)) / 3, seg) <= CLEAR2) return true
          if (segmentsCross(x, y, x2, y2, seg.x1, seg.y1, seg.x2, seg.y2)) return true
        }
      }
    }
  }
  return false
}

const visibleBuildings = buildings.features.filter((feature) => !onPavedRoad(feature))

const BUILDING_DATA = {
  type: 'FeatureCollection',
  features: visibleBuildings.map((feature, id) => ({ ...feature, id })),
}

/** A few points inside each footprint, so the sampled colour is the roof rather than the road. */
const BUILDING_SPOTS = visibleBuildings.map((feature, id) => {
  const ring = feature.geometry.coordinates[0]
  const n = Math.max(1, ring.length - 1)
  let lng = 0
  let lat = 0
  for (let i = 0; i < n; i++) {
    lng += ring[i][0]
    lat += ring[i][1]
  }
  lng /= n
  lat /= n
  const pts = [[lng, lat]]
  const step = Math.max(1, Math.floor(n / 4))
  for (let i = 0; i < n && pts.length < 5; i += step) {
    pts.push([lng + (ring[i][0] - lng) * 0.45, lat + (ring[i][1] - lat) * 0.45])
  }
  return { id, lng, lat, pts }
})

const tileCache = Object.create(null)

function tilePixel(lng, lat) {
  const n = 2 ** COLOR_ZOOM
  const xf = ((lng + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const x = Math.floor(xf)
  const y = Math.floor(yf)
  return {
    x,
    y,
    px: Math.min(255, Math.max(0, Math.floor((xf - x) * 256))),
    py: Math.min(255, Math.max(0, Math.floor((yf - y) * 256))),
  }
}

function tilePixels(x, y) {
  const key = `${x}/${y}`
  if (tileCache[key]) return tileCache[key]
  const pending = new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0, 256, 256)
      resolve(ctx.getImageData(0, 0, 256, 256).data)
    }
    img.onerror = () => resolve(null)
    img.src = SATELLITE[0].replace('{z}', String(COLOR_ZOOM)).replace('{y}', String(y)).replace('{x}', String(x))
  })
  tileCache[key] = pending
  return pending
}

function pixelAt(data, px, py) {
  const i = (py * 256 + px) * 4
  return [data[i], data[i + 1], data[i + 2]]
}

function isVegetation(r, g, b) {
  return g > r + 14 && g > b + 8 && g > 60
}

async function roofColor(spot) {
  const samples = []
  for (const [lng, lat] of spot.pts) {
    const { x, y, px, py } = tilePixel(lng, lat)
    const data = await tilePixels(x, y)
    if (!data) continue
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const [rr, gg, bb] = pixelAt(data, Math.min(255, Math.max(0, px + dx)), Math.min(255, Math.max(0, py + dy)))
        r += rr
        g += gg
        b += bb
        count += 1
      }
    }
    samples.push([r / count, g / count, b / count])
  }
  const roofs = samples.filter(([r, g, b]) => !isVegetation(r, g, b))
  const picked = roofs.length ? roofs : samples
  if (!picked.length) return null
  picked.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]))
  const [r, g, b] = picked[Math.floor(picked.length / 2)]
  const lift = (c) => Math.round(Math.max(0, Math.min(255, (c - 128) * 1.15 + 128)))
  return [lift(r), lift(g), lift(b)]
}

const roofPaint = [
  'case',
  ['boolean', ['feature-state', 'ready'], false],
  ['rgb', ['feature-state', 'r'], ['feature-state', 'g'], ['feature-state', 'b']],
  '#d7c3a4',
]
const wallPaint = [
  'case',
  ['boolean', ['feature-state', 'ready'], false],
  ['rgb', ['*', ['feature-state', 'r'], 0.58], ['*', ['feature-state', 'g'], 0.54], ['*', ['feature-state', 'b'], 0.5]],
  '#a89880',
]

/**
 * Tilt-and-rotate satellite view. Each block's roof colour is sampled from the
 * imagery, and the walls are a darker shade of that colour. Height is still
 * estimated from footprint size.
 */
export default function CorridorBuildingsMap({ center, bearing, roadGeo, windowGeo, basemap = 'satellite' }) {
  const ref = useRef(null)
  const mapRef = useRef(null)
  const roadRef = useRef(roadGeo)
  const windowRef = useRef(windowGeo)
  roadRef.current = roadGeo
  windowRef.current = windowGeo

  useEffect(() => {
    const el = ref.current
    if (!el || !center) return undefined
    let alive = true
    let coloring = false
    let queued = false
    const colored = new Set()
    const map = new MapLibreMap({
      container: el,
      style: {
        version: 8,
        sources: {
          sat: {
            type: 'raster',
            tiles: SATELLITE,
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Tiles © Esri',
          },
        },
        layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
      },
      center,
      zoom: 16.2,
      pitch: 58,
      bearing: Number.isFinite(bearing) ? bearing : 0,
      maxPitch: 78,
      attributionControl: true,
      dragRotate: true,
      pitchWithRotate: true,
      touchPitch: true,
    })
    map.addControl(new NavigationControl({ visualizePitch: true, showZoom: false }), 'bottom-right')

    const paintVisible = async () => {
      if (!alive || !map.getSource('buildings')) return
      if (coloring) {
        queued = true
        return
      }
      const bounds = map.getBounds()
      const west = bounds.getWest() - 0.004
      const east = bounds.getEast() + 0.004
      const south = bounds.getSouth() - 0.004
      const north = bounds.getNorth() + 0.004
      const pending = BUILDING_SPOTS.filter(
        (spot) => !colored.has(spot.id) && spot.lng >= west && spot.lng <= east && spot.lat >= south && spot.lat <= north,
      )
      if (!pending.length) return
      coloring = true
      const batch = pending.slice(0, 60)
      await Promise.all(
        batch.map(async (spot) => {
          const rgb = await roofColor(spot)
          if (!alive || !rgb) return
          map.setFeatureState({ source: 'buildings', id: spot.id }, { ready: true, r: rgb[0], g: rgb[1], b: rgb[2] })
          colored.add(spot.id)
        }),
      )
      coloring = false
      if (alive && (queued || pending.length > batch.length)) {
        queued = false
        paintVisible()
      }
    }

    map.on('load', () => {
      map.addSource('buildings', { type: 'geojson', data: BUILDING_DATA })
      map.addLayer({
        id: 'building-walls',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          'fill-extrusion-color': wallPaint,
          'fill-extrusion-height': ['-', ['get', 'height'], 0.45],
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': true,
        },
      })
      map.addLayer({
        id: 'building-roofs',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          'fill-extrusion-color': roofPaint,
          'fill-extrusion-base': ['-', ['get', 'height'], 0.5],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-opacity': 1,
        },
      })
      map.addSource('road', { type: 'geojson', data: roadRef.current })
      map.addLayer({
        id: 'road-iri',
        type: 'line',
        source: 'road',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3.5,
        },
      })
      map.addSource('window', { type: 'geojson', data: windowRef.current })
      map.addLayer({
        id: 'window-line',
        type: 'line',
        source: 'window',
        paint: { 'line-color': '#ffffff', 'line-width': 1.6 },
      })
      paintVisible()
    })
    map.on('moveend', paintVisible)

    mapRef.current = map
    const ro = new ResizeObserver(() => map.resize())
    ro.observe(el)
    requestAnimationFrame(() => map.resize())
    return () => {
      alive = false
      ro.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return undefined
    const run = () => {
      if (mapRef.current !== map) return
      applyRaster(map, basemap)
    }
    if (map.isStyleLoaded()) run()
    else map.once('load', run)
    return () => map.off('load', run)
  }, [basemap])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !center) return undefined
    const apply = () => {
      if (!map.getSource('road')) return
      map.getSource('road').setData(roadGeo)
      map.getSource('window').setData(windowGeo)
      map.easeTo({ center, duration: 350, essential: true })
    }
    if (map.isStyleLoaded() && map.getSource('road')) apply()
    else map.once('idle', apply)
    return undefined
  }, [center?.[0], center?.[1], roadGeo, windowGeo])

  return (
    <div className="absolute inset-0 z-[550]">
      <div ref={ref} className="h-full w-full" />
    </div>
  )
}
