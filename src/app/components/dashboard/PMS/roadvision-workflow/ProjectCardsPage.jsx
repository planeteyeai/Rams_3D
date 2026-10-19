import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import medianData from '../../../../../assets/data/nanasa-median.json'
import invData from '../../../../../assets/data/adani-inventory.json'
import reportedData from '../../../../../assets/data/adani-reported.json'
import { IconArrow, IconCompress, IconExpand, IconLayers, IconMinus, IconPlus } from './Icons'
import { PROJECTS, getStoredProjectId, setStoredProjectId } from './constants'

const NANASA_NAME = 'ADANI-NANASA (NPRPL)'
const NANASA_LINE = (medianData.coordinates || []).map(([lng, lat]) => [lat, lng])
const NANASA_CUM = (() => {
  const cum = [0]
  for (let i = 1; i < NANASA_LINE.length; i++) {
    const [lat0, lng0] = NANASA_LINE[i - 1]
    const [lat1, lng1] = NANASA_LINE[i]
    const dx = (lng1 - lng0) * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180) * 111320
    const dy = (lat1 - lat0) * 110540
    cum.push(cum[cum.length - 1] + Math.hypot(dx, dy))
  }
  return cum
})()

function pointAtDistance(d) {
  const cum = NANASA_CUM
  const total = cum[cum.length - 1] || 1
  const dist = Math.max(0, Math.min(d, total))
  let i = 1
  while (i < cum.length - 1 && cum[i] < dist) i += 1
  const seg = cum[i] - cum[i - 1] || 1
  const t = (dist - cum[i - 1]) / seg
  const [lat0, lng0] = NANASA_LINE[i - 1]
  const [lat1, lng1] = NANASA_LINE[i]
  return [lat0 + (lat1 - lat0) * t, lng0 + (lng1 - lng0) * t]
}

function lineBetween(from, to) {
  const total = NANASA_CUM[NANASA_CUM.length - 1] || 1
  const span = ROAD_MAX - ROAD_MIN || 1
  const d0 = Math.max(0, ((from - ROAD_MIN) / span) * total)
  const d1 = Math.min(total, ((to - ROAD_MIN) / span) * total)
  const pts = [pointAtDistance(d0)]
  for (let i = 0; i < NANASA_CUM.length; i++) {
    if (NANASA_CUM[i] > d0 && NANASA_CUM[i] < d1) pts.push(NANASA_LINE[i])
  }
  const end = pointAtDistance(d1)
  const prev = pts[pts.length - 1]
  if (Math.hypot(end[0] - prev[0], end[1] - prev[1]) > 1e-7) pts.push(end)
  return pts
}

const roadEnds = () => {
  let min = Infinity
  let max = -Infinity
  const touch = (a, b) => {
    if (Number.isFinite(a)) min = Math.min(min, a)
    if (Number.isFinite(b)) max = Math.max(max, b)
  }
  ;(invData.points || []).forEach((r) => touch(Number(r.start), Number(r.end ?? r.start)))
  ;(invData.lines || []).forEach((r) => touch(Number(r.start), Number(r.end ?? r.start)))
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [95.01, 142.95]
  return [Math.round(min * 100) / 100, Math.round(max * 100) / 100]
}
const [ROAD_MIN, ROAD_MAX] = roadEnds()

const fullInventory = () => {
  const types = invData.types || []
  return { total: types.reduce((n, t) => n + (t.n || 0), 0), types }
}

function matchesSide(dir, side) {
  if (side === 'both') return true
  const d = String(dir || '').toLowerCase()
  return side === 'inc' ? d.startsWith('inc') : d.startsWith('dec')
}

function inventoryBetween(from, to, side = 'both') {
  if (side === 'both' && from <= ROAD_MIN + 0.001 && to >= ROAD_MAX - 0.001) return fullInventory()
  const tally = Object.fromEntries((invData.types || []).map((t) => [t.id, 0]))
  ;(invData.points || []).forEach((p) => {
    if (!matchesSide(p.dir, side)) return
    const a = Number(p.start)
    const b = Number(p.end ?? p.start)
    if (b > from && a < to) tally[p.asset] = (tally[p.asset] || 0) + 1
  })
  ;(invData.lines || []).forEach((l) => {
    if (!matchesSide(l.dir, side)) return
    const a = Number(l.start)
    const b = Number(l.end ?? l.start)
    const len = b - a
    if (!(b > from && a < to) || len <= 0) return
    const overlap = Math.min(b, to) - Math.max(a, from)
    tally[l.asset] = (tally[l.asset] || 0) + (l.n || 0) * (overlap / len)
  })
  const types = (invData.types || []).map((t) => ({ ...t, n: Math.round(tally[t.id] || 0) }))
  return { total: types.reduce((n, t) => n + t.n, 0), types }
}

const DISTRESS_SIDES = [
  { id: 'LHS', label: 'LHS', hint: 'Increasing', road: 'main', dir: 'inc', color: '#2f6f68' },
  { id: 'RHS', label: 'RHS', hint: 'Decreasing', road: 'main', dir: 'dec', color: '#3b5b8a' },
  { id: 'sinc', label: 'S Increasing', hint: 'Service Road', road: 'service', dir: 'inc', color: '#8a6540' },
  { id: 'sdec', label: 'S Decreasing', hint: 'Service Road', road: 'service', dir: 'dec', color: '#5b4b7a' },
]

const DISTRESS_TYPES = ['Cracking', 'Raveling', 'Settlement', 'Pothole', 'Faulting', 'Bleeding']

const DISTRESS_COLORS = {
  Cracking: '#b86b3a',
  Raveling: '#a8893c',
  Settlement: '#6b5b8a',
  Pothole: '#a84a4a',
  Faulting: '#4a6fa5',
  Bleeding: '#6b7280',
}

const ASSET_ACCENTS = {
  Kerb: '#64748b',
  'Crash Barrier': '#ea580c',
  'Street Lights': '#eab308',
  Trees: '#22c55e',
  'Median Plants': '#16a34a',
  'Sign Boards': '#f59e0b',
  'Hazard Markers': '#f97316',
  Culvert: '#a16207',
  Delineators: '#fbbf24',
  'KM Stones': '#64748b',
  'Service Road': '#f97316',
  'Adjacent Road': '#3b82f6',
  'Bus Shelters': '#06b6d4',
  'Bus Bays': '#14b8a6',
  'Fuel Station': '#6366f1',
  'Solar Blinker': '#eab308',
  'Pedestrian Guard Rail': '#8b5cf6',
  'Toll Plaza': '#3b82f6',
  'Truck Layby': '#22c55e',
  'Median Opening': '#60a5fa',
}

function assetAccent(id, fallback) {
  return ASSET_ACCENTS[id] || fallback || '#94a3b8'
}

function distressBetween(from, to, side = 'both') {
  const groups = DISTRESS_SIDES.filter((g) => side === 'both' || g.dir === side).map((sideRow) => ({
    ...sideRow,
    total: 0,
    types: Object.fromEntries(DISTRESS_TYPES.map((name) => [name, 0])),
  }))
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]))
  ;(reportedData.records || []).forEach((r) => {
    const a = Number(r.chainage_start)
    const b = Number(r.chainage_end ?? r.chainage_start)
    if (!(b > from && a < to)) return
    const inc = String(r.direction || '').toLowerCase().startsWith('inc')
    if (side === 'inc' && !inc) return
    if (side === 'dec' && inc) return
    const service = String(r.road || '').toLowerCase() === 'service'
    const id = service ? (inc ? 'sinc' : 'sdec') : (inc ? 'LHS' : 'RHS')
    const group = byId[id]
    if (!group) return
    group.total += 1
    const kind = r.distress_type || 'Distress'
    group.types[kind] = (group.types[kind] || 0) + 1
  })
  return groups
}

function distressGroupId(r) {
  const inc = String(r.direction || '').toLowerCase().startsWith('inc')
  const service = String(r.road || '').toLowerCase() === 'service'
  return service ? (inc ? 'sinc' : 'sdec') : (inc ? 'LHS' : 'RHS')
}

function distressForMap(focus, from, to, side) {
  if (!focus) return []
  return (reportedData.records || []).filter((r) => {
    const a = Number(r.chainage_start)
    const b = Number(r.chainage_end ?? r.chainage_start)
    if (!(b > from && a < to)) return false
    if (!matchesSide(r.direction, side)) return false
    if (focus.group && distressGroupId(r) !== focus.group) return false
    if (focus.type && r.distress_type !== focus.type) return false
    return Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude))
  })
}

const SIDE_OPTIONS = [
  { id: 'inc', label: 'Increasing' },
  { id: 'dec', label: 'Decreasing' },
  { id: 'both', label: 'Both' },
]

const MAP_LAYERS = {
  satellite: {
    url: 'https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    maxZoom: 19,
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
  },
  terrain: {
    url: 'https://{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    maxZoom: 18,
  },
}

const MAJOR_ASSETS = new Set(['Kerb', 'Crash Barrier'])

const ASSET_ORDER = [
  'Kerb', 'Crash Barrier', 'Street Lights', 'Trees', 'Median Plants', 'Sign Boards',
  'Hazard Markers', 'Culvert', 'Delineators', 'KM Stones', 'Service Road', 'Adjacent Road',
  'Bus Shelters', 'Bus Bays', 'Fuel Station', 'Solar Blinker', 'Pedestrian Guard Rail',
  'Toll Plaza', 'Truck Layby', 'Median Opening',
]

function sortedTypes(types) {
  return [...types].sort((a, b) => {
    const ia = ASSET_ORDER.indexOf(a.id)
    const ib = ASSET_ORDER.indexOf(b.id)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

function AssetGlyph({ name, className = 'h-3.5 w-3.5' }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': true }
  switch (name) {
    case 'Kerb':
      return <svg {...common}><path d="M3 16h18M5 16V8h14v8" /></svg>
    case 'Crash Barrier':
      return <svg {...common}><path d="M3 9h18M3 15h18M6 9v6M18 9v6" /></svg>
    case 'Street Lights':
      return <svg {...common}><path d="M9 21h6M12 21V9M12 9h6l-1.5 3H12" /><circle cx="12" cy="6" r="2" /></svg>
    case 'Trees':
      return <svg {...common}><path d="M12 22v-7M7 15c0-4 2.2-8 5-8s5 4 5 8H7Z" /></svg>
    case 'Median Plants':
      return <svg {...common}><path d="M12 21V11M8 14c1-4 4-7 4-7s3 3 4 7M9 21h6" /></svg>
    case 'Sign Boards':
      return <svg {...common}><rect x="5" y="4" width="14" height="10" rx="1.5" /><path d="M12 14v7M9 21h6" /></svg>
    case 'Hazard Markers':
      return <svg {...common}><path d="M12 3 21 19H3L12 3Z" /><path d="M12 10v4M12 17h.01" /></svg>
    case 'Culvert':
      return <svg {...common}><path d="M3 18h18M5 18v-6a7 7 0 0 1 14 0v6" /></svg>
    case 'Delineators':
      return <svg {...common}><path d="M12 21V8M8 21h8" /><circle cx="12" cy="6" r="2.4" /></svg>
    case 'KM Stones':
      return <svg {...common}><path d="M8 21h8M10 21V8l2-3 2 3v13" /></svg>
    case 'Service Road':
      return <svg {...common}><path d="M4 18h16M7 18 9 6h6l2 12M12 10v2" /></svg>
    case 'Adjacent Road':
      return <svg {...common}><path d="M3 7h18M3 17h18M8 7v10M16 7v10" /></svg>
    case 'Bus Shelters':
      return <svg {...common}><path d="M4 11h16v9H4zM4 11 12 5l8 6M8 20v-4h3v4" /></svg>
    case 'Bus Bays':
      return <svg {...common}><rect x="3" y="8" width="18" height="9" rx="2" /><path d="M6 8 8 5h8l2 3" /></svg>
    case 'Fuel Station':
      return <svg {...common}><rect x="4" y="4" width="10" height="16" rx="1.5" /><path d="M14 9h3v8a2 2 0 1 0 2-2" /></svg>
    case 'Solar Blinker':
      return <svg {...common}><rect x="7" y="10" width="10" height="8" rx="1" /><path d="M12 10V6M9 4h6M12 18v3" /></svg>
    case 'Pedestrian Guard Rail':
      return <svg {...common}><path d="M4 8h16M4 14h16M6 8v12M18 8v12" /></svg>
    case 'Toll Plaza':
      return <svg {...common}><path d="M4 20V8l8-4 8 4v12M8 20v-6h8v6" /></svg>
    case 'Truck Layby':
      return <svg {...common}><rect x="3" y="10" width="13" height="7" rx="1.4" /><path d="M16 13h4v4h-4M7 17v2M14 17v2" /></svg>
    case 'Median Opening':
      return <svg {...common}><path d="M4 7h6M14 7h6M4 17h6M14 17h6M10 7v10M14 7v10" /></svg>
    default:
      return <svg {...common}><circle cx="12" cy="12" r="7" /></svg>
  }
}

function SideSelect({ value, onChange }) {
  return (
    <div className="flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-0.5" role="tablist" aria-label="Direction">
      {SIDE_OPTIONS.map((opt) => {
        const on = value === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(opt.id)}
            className={`rounded-[5px] px-2.5 py-1.5 text-[11px] font-semibold transition sm:px-3 ${
              on ? 'bg-white text-[#0f1f3d] shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-[#0f1f3d]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function RoadRangeBar({ from, to, onChange }) {
  const track = useRef(null)
  const span = ROAD_MAX - ROAD_MIN || 1
  const pct = (v) => ((v - ROAD_MIN) / span) * 100
  const at = (clientX) => {
    const box = track.current?.getBoundingClientRect()
    if (!box?.width) return from
    const t = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return Math.round((ROAD_MIN + t * span) * 100) / 100
  }
  const drag = (edge, event) => {
    event.preventDefault()
    event.stopPropagation()
    const move = (ev) => {
      const v = at(ev.clientX)
      if (edge === 'from') onChange(Math.min(v, to - 0.1), to)
      else onChange(from, Math.max(v, from + 0.1))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const selected = (to - from).toFixed(2)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[#0b1424]" title="Start chainage">
        Ch {from.toFixed(2)}
      </span>
      <div ref={track} className="relative h-1.5 min-w-0 flex-1 rounded-full bg-[#e2e8f0]">
        <div
          className="absolute inset-y-0 rounded-full bg-[#1e3a5f]"
          style={{ left: `${pct(from)}%`, width: `${Math.max(pct(to) - pct(from), 0)}%` }}
        />
        {['from', 'to'].map((edge) => (
          <button
            key={edge}
            type="button"
            aria-label={edge === 'from' ? 'Start chainage' : 'End chainage'}
            onPointerDown={(e) => drag(edge, e)}
            className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-[#1e3a5f] shadow-sm"
            style={{ left: `${pct(edge === 'from' ? from : to)}%` }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[#0b1424]" title="End chainage">
        Ch {to.toFixed(2)}
      </span>
      <span className="shrink-0 rounded bg-[#0b1424] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white" title="Selected stretch">
        {selected} km
      </span>
    </div>
  )
}

function overlapsRange(start, end, from, to) {
  const a = Number(start)
  const b = Number(end ?? start)
  return Number.isFinite(a) && Number.isFinite(b) && b > from && a < to
}

function assetsForMap(assetId, from, to, side) {
  if (!assetId) return { points: [], lines: [], color: '#22d3ee' }
  const meta = (invData.types || []).find((t) => t.id === assetId)
  const color = meta?.color || '#f59e0b'
  if (meta?.kind === 'line') {
    const lines = (invData.lines || []).filter(
      (l) => l.asset === assetId && matchesSide(l.dir, side) && overlapsRange(l.start, l.end, from, to),
    )
    return { points: [], lines, color }
  }
  const points = (invData.points || []).filter(
    (p) =>
      p.asset === assetId &&
      matchesSide(p.dir, side) &&
      overlapsRange(p.start, p.end, from, to) &&
      Number.isFinite(Number(p.lat)) &&
      Number.isFinite(Number(p.lng)),
  )
  return { points, lines: [], color }
}

function addTile(map, layerId) {
  const spec = MAP_LAYERS[layerId] || MAP_LAYERS.satellite
  return L.tileLayer(spec.url, {
    maxZoom: spec.maxZoom || 18,
    subdomains: spec.subdomains,
  }).addTo(map)
}

function CorridorMap({ project, from, to, side = 'both', mapAsset = null, distressFocus = null, chrome = true, onAssetClick }) {
  const ref = useRef(null)
  const wrapRef = useRef(null)
  const mapRef = useRef(null)
  const hiRef = useRef(null)
  const fullLineRef = useRef(null)
  const marksRef = useRef(null)
  const assetRef = useRef(null)
  const tileRef = useRef(null)
  const layerRef = useRef('satellite')
  const userZoomedRef = useRef(false)
  const programmaticViewRef = useRef(false)
  const onAssetClickRef = useRef(onAssetClick)
  onAssetClickRef.current = onAssetClick
  const [full, setFull] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [activeLayer, setActiveLayer] = useState('satellite')

  const fitFullCorridor = (animate = false) => {
    const m = mapRef.current
    const line = fullLineRef.current
    if (!m || !line) return
    programmaticViewRef.current = true
    m.fitBounds(line.getBounds(), { padding: [28, 28], animate })
    m.once('moveend', () => { programmaticViewRef.current = false })
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    userZoomedRef.current = false
    const m = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: chrome,
      scrollWheelZoom: chrome,
      doubleClickZoom: chrome,
      boxZoom: false,
      keyboard: chrome,
    })
    tileRef.current = addTile(m, 'satellite')
    if (project.id === 'adani-nanasa-nprpl' && NANASA_LINE.length > 1) {
      fullLineRef.current = L.polyline(NANASA_LINE, { color: '#ffffff', weight: 2, opacity: 0.35 }).addTo(m)
      hiRef.current = L.polyline(lineBetween(from ?? ROAD_MIN, to ?? ROAD_MAX), {
        color: '#dbe7f0',
        weight: 5,
        opacity: 1,
      }).addTo(m)
      marksRef.current = L.layerGroup().addTo(m)
      programmaticViewRef.current = true
      m.fitBounds(fullLineRef.current.getBounds(), { padding: [28, 28] })
      m.once('moveend', () => { programmaticViewRef.current = false })
    } else {
      L.circleMarker([project.lat, project.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1e3a5f',
        fillOpacity: 1,
      }).addTo(m)
      m.setView([project.lat, project.lng], 11)
    }
    assetRef.current = L.featureGroup().addTo(m)
    mapRef.current = m
    const markUserZoom = () => {
      if (!programmaticViewRef.current) userZoomedRef.current = true
    }
    m.on('zoomstart', markUserZoom)
    m.on('dragstart', markUserZoom)
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el)
    const t = setTimeout(() => m.invalidateSize(), 80)
    const onFs = () => setFull(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      clearTimeout(t)
      ro.disconnect()
      document.removeEventListener('fullscreenchange', onFs)
      m.off('zoomstart', markUserZoom)
      m.off('dragstart', markUserZoom)
      m.remove()
      mapRef.current = null
      hiRef.current = null
      fullLineRef.current = null
      marksRef.current = null
      assetRef.current = null
      tileRef.current = null
    }
  }, [project])

  useEffect(() => {
    const m = mapRef.current
    if (!m || layerRef.current === activeLayer) return
    layerRef.current = activeLayer
    if (tileRef.current) m.removeLayer(tileRef.current)
    tileRef.current = addTile(m, activeLayer)
    tileRef.current.bringToBack()
    fullLineRef.current?.bringToFront()
    hiRef.current?.bringToFront()
    marksRef.current?.eachLayer((l) => l.bringToFront?.())
    assetRef.current?.bringToFront()
  }, [activeLayer])

  useEffect(() => {
    const m = mapRef.current
    const hi = hiRef.current
    const marks = marksRef.current
    if (!m || !hi || project.id !== 'adani-nanasa-nprpl') return
    const pts = lineBetween(from, to)
    hi.setLatLngs(pts)
    if (marks) {
      marks.clearLayers()
      if (pts.length > 1) {
        const start = pts[0]
        const end = pts[pts.length - 1]
        L.circleMarker(start, { radius: 6, color: '#fff', weight: 2, fillColor: '#94a3b8', fillOpacity: 1 })
          .bindTooltip(`Ch ${from.toFixed(2)}`, { permanent: true, direction: 'top', offset: [0, -8], className: 'ch-tip' })
          .addTo(marks)
        L.circleMarker(end, { radius: 6, color: '#fff', weight: 2, fillColor: '#e2e8f0', fillOpacity: 1 })
          .bindTooltip(`Ch ${to.toFixed(2)}`, { permanent: true, direction: 'bottom', offset: [0, 8], className: 'ch-tip' })
          .addTo(marks)
      }
    }
    // Keep the full corridor in view; do not zoom into the selected stretch or assets.
    if (!userZoomedRef.current) fitFullCorridor(false)
  }, [from, to, project.id])

  useEffect(() => {
    const layerGroup = assetRef.current
    if (!layerGroup || project.id !== 'adani-nanasa-nprpl') return
    layerGroup.clearLayers()
    if (distressFocus) {
      distressForMap(distressFocus, from, to, side).forEach((r) => {
        const ll = [Number(r.latitude), Number(r.longitude)]
        const color = DISTRESS_COLORS[r.distress_type] || '#a84a4a'
        L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.95 }).addTo(layerGroup)
      })
      return
    }
    const { points, lines, color } = assetsForMap(mapAsset, from, to, side)
    points.forEach((p) => {
      const ll = [Number(p.lat), Number(p.lng)]
      const mark = L.circleMarker(ll, {
        radius: 6,
        color: '#ffffff',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.95,
        className: 'inv-marker',
      })
      const ch = Number.isFinite(Number(p.start)) ? Number(p.start).toFixed(2) : ''
      mark.bindTooltip(`${p.asset || mapAsset}${ch ? ` · Ch ${ch}` : ''} · open 3D`, {
        direction: 'top',
        offset: [0, -6],
        className: 'ch-tip',
      })
      mark.on('click', (ev) => {
        L.DomEvent.stop(ev)
        onAssetClickRef.current?.(p)
      })
      mark.addTo(layerGroup)
    })
    lines.forEach((l) => {
      const latlngs = (l.latlngs || []).map(([lat, lng]) => [lat, lng])
      if (latlngs.length < 2) return
      const line = L.polyline(latlngs, { color, weight: 3, opacity: 0.9, className: 'inv-marker' })
      line.bindTooltip(`${l.asset || mapAsset} · open 3D`, { direction: 'top', className: 'ch-tip' })
      line.on('click', (ev) => {
        L.DomEvent.stop(ev)
        onAssetClickRef.current?.(l)
      })
      line.addTo(layerGroup)
    })
  }, [mapAsset, distressFocus, from, to, side, project.id])

  const zoom = (dir) => {
    const m = mapRef.current
    if (!m) return
    if (dir > 0) m.zoomIn()
    else m.zoomOut()
  }

  const toggleFull = async () => {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
    setTimeout(() => mapRef.current?.invalidateSize(), 120)
  }

  const overlayTitle = distressFocus
    ? `${distressFocus.type || DISTRESS_SIDES.find((g) => g.id === distressFocus.group)?.label || 'Distress'} locations`
    : mapAsset
      ? mapAsset
      : 'Selected stretch'
  const sideLabel = SIDE_OPTIONS.find((o) => o.id === side)?.label || 'Both'

  return (
    <div ref={wrapRef} className={`relative h-full overflow-hidden bg-slate-300 ${chrome ? 'min-h-[260px]' : ''}`}>
      <div ref={ref} className="h-full w-full" />
      {chrome ? (
        <>
          <div className="absolute left-2 top-2 z-[500] flex flex-col overflow-hidden rounded-md">
            <button type="button" className="gis-control rounded-none" aria-label="Zoom in" onClick={() => zoom(1)}>
              <IconPlus />
            </button>
            <button type="button" className="gis-control rounded-none border-t-0" aria-label="Zoom out" onClick={() => zoom(-1)}>
              <IconMinus />
            </button>
          </div>
          <div className="absolute right-2 top-2 z-[500] flex flex-col items-end gap-1">
            <div className="relative">
              <button type="button" className="gis-control rounded-md" aria-label="Map layers" onClick={() => setLayersOpen((v) => !v)}>
                <IconLayers className="h-3.5 w-3.5" />
              </button>
              {layersOpen && (
                <div className="absolute right-0 top-9 w-28 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-[11px] shadow-md">
                  {['satellite', 'street', 'terrain'].map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { setActiveLayer(id); setLayersOpen(false) }}
                      className={`block w-full px-2.5 py-1.5 text-left capitalize ${activeLayer === id ? 'bg-slate-50 font-semibold text-[#1d4ed8]' : 'text-slate-600 hover:bg-slate-50'}`}
                    >
                      {id}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="gis-control rounded-md" aria-label={full ? 'Exit fullscreen' : 'Fullscreen map'} onClick={toggleFull}>
              {full ? <IconCompress className="h-3.5 w-3.5" /> : <IconExpand className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-[500] flex items-end justify-between gap-2">
            <div className="rounded-md bg-[#0f1f3d]/85 px-2.5 py-1.5 text-white shadow-sm backdrop-blur-sm">
              <p className="m-0 text-[9px] font-semibold uppercase tracking-[0.12em] text-white/65">{overlayTitle}</p>
              <p className="m-0 text-[12px] font-semibold tabular-nums">Ch {from.toFixed(2)} – {to.toFixed(2)} km</p>
              <p className="m-0 text-[10px] text-white/80">{(to - from).toFixed(2)} km · {sideLabel}</p>
            </div>
            <div className="rounded-md bg-white/90 px-2 py-1.5 text-[10px] text-[#0f1f3d] shadow-sm">
              <span className="mr-1.5 inline-block h-1.5 w-4 rounded-full bg-[#67e8f9] align-middle" />
              Selected stretch
            </div>
          </div>
          {activeLayer !== 'street' ? (
            <span className="absolute right-2 bottom-[52px] z-[400] rounded bg-black/40 px-1 py-0.5 text-[8px] font-medium text-white/90">© Google</span>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function CountCard({ type, selected, onSelect }) {
  const major = MAJOR_ASSETS.has(type.id)
  const accent = assetAccent(type.id, type.color)
  return (
    <button
      type="button"
      title={`${type.id}: ${Number(type.n).toLocaleString()} assets`}
      onClick={() => onSelect?.(type.id)}
      className={`relative box-border grid h-full min-h-0 grid-cols-[auto_minmax(0,1fr)] grid-rows-[1fr_auto] items-center gap-x-2 gap-y-0 overflow-hidden rounded border px-2 pb-2.5 pt-1.5 text-left transition ${
        selected
          ? 'border-[#1e3a5f] bg-[#e8eef4]'
          : major
            ? 'border-[#d0d7e0] bg-white hover:bg-[#f8f9fb]'
            : 'border-[#e2e8f0] bg-white hover:bg-[#f8f9fb]'
      }`}
    >
      <span
        className={`row-span-2 grid h-8 w-8 shrink-0 place-items-center self-center rounded ${selected ? 'bg-[#1e3a5f] text-white' : ''}`}
          style={selected ? undefined : { background: `${accent}28`, color: accent }}
        >
          <AssetGlyph name={type.id} className="h-5 w-5" />
        </span>
        <span className="min-w-0 self-end truncate text-[11px] font-medium leading-none text-slate-500">{type.id}</span>
        <span className="min-w-0 self-start text-[18px] font-semibold tabular-nums leading-none text-[#0b1424]">
          {Number(type.n).toLocaleString()}
        </span>
        <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: accent }} />
    </button>
  )
}

function DistressCard({ group, selected, selectedType, onSelect, onType }) {
  const max = Math.max(1, ...DISTRESS_TYPES.map((n) => group.types[n] || 0))
  const active = selected && !selectedType
  return (
    <article
      className={`grid h-full min-h-0 grid-rows-[34px_repeat(6,minmax(0,1fr))] overflow-hidden rounded border bg-white ${
        active ? 'border-[#1e3a5f]' : 'border-[#e2e8f0]'
      }`}
      style={{ boxShadow: `inset 3px 0 0 ${group.color}` }}
    >
      <button
        type="button"
        onClick={() => onSelect(group.id)}
        className="grid grid-cols-[1fr_auto] items-center gap-1.5 border-b border-[#eef1f4] px-2 text-left"
        title={`Show ${group.label} distress on map`}
      >
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-semibold leading-none text-[#0b1424]">{group.label}</span>
          <span className="mt-0.5 block truncate text-[9px] font-semibold uppercase tracking-[0.06em] text-slate-400">{group.hint}</span>
        </span>
        <span className="text-[18px] font-semibold tabular-nums leading-none text-[#0b1424]">{group.total}</span>
      </button>
      {DISTRESS_TYPES.map((name) => {
        const v = group.types[name] || 0
        const on = selected && selectedType === name
        return (
          <button
            key={name}
            type="button"
            onClick={() => onType(group.id, name)}
            className={`grid grid-cols-[6px_minmax(4.5rem,auto)_minmax(0,1fr)_1.5rem] items-center gap-1.5 px-2 text-left ${on ? 'bg-[#eef2f6]' : 'hover:bg-[#f8f9fb]'}`}
            title={`Highlight ${name} on map`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: DISTRESS_COLORS[name] }} />
            <span className="truncate text-[11px] text-slate-600">{name}</span>
            <span className="h-1.5 min-w-0 overflow-hidden rounded-full bg-[#eef1f4]">
              <span className="block h-full rounded-full" style={{ width: `${(v / max) * 100}%`, background: DISTRESS_COLORS[name] }} />
            </span>
            <span className={`text-right text-[11px] font-semibold tabular-nums ${v ? 'text-[#0b1424]' : 'text-slate-300'}`}>{v}</span>
          </button>
        )
      })}
    </article>
  )
}

function NanasaDashboard({
  project,
  open,
  roadFrom,
  roadTo,
  onRange,
  side,
  onSide,
  inventory,
  distress,
  mapAsset,
  onMapAsset,
  distressFocus,
  onDistressFocus,
}) {
  const distressTotal = distress.reduce((n, g) => n + g.total, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] bg-white px-4 py-2 lg:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="m-0 shrink-0 text-[20px] font-semibold tracking-tight text-[#0b1424]">{project.name}</h1>
          <span className="shrink-0 rounded bg-[#e8eef4] px-2 py-0.5 text-[12px] font-bold tracking-[0.1em] text-[#1e3a5f]">{project.code}</span>
          <span className="hidden h-4 w-px shrink-0 bg-[#e2e8f0] sm:block" aria-hidden />
          <p className="m-0 min-w-0 truncate text-[15px] text-slate-500">
            {project.place} · {project.corridor} · {project.km}
          </p>
        </div>
        <button
          type="button"
          onClick={() => open(project)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[#1e3a5f] px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-[#243b55]"
        >
          Open 3D Viewer <IconArrow className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(300px,36%)_minmax(0,1fr)]">
        <section className="relative max-h-[34vh] min-h-[200px] border-b border-[#e2e8f0] lg:max-h-none lg:min-h-0 lg:border-b-0 lg:border-r">
          <CorridorMap
            project={project}
            from={roadFrom}
            to={roadTo}
            side={side}
            mapAsset={mapAsset}
            distressFocus={distressFocus}
            onAssetClick={(rec) => {
              const s = Number(rec.start)
              const e = Number(rec.end ?? rec.start)
              const chainage = Number.isFinite(e) && e > s ? (s + e) / 2 : s
              const d = String(rec.dir || '').toLowerCase()
              open(project, {
                chainage,
                asset: rec.asset || mapAsset,
                side: d.startsWith('inc') ? 'inc' : d.startsWith('dec') ? 'dec' : side,
              })
            }}
          />
        </section>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1.05fr)_minmax(0,1fr)] gap-1.5 overflow-hidden bg-[#eef1f5] p-2">
          <div className="flex shrink-0 flex-wrap items-center gap-2 rounded border border-[#e2e8f0] bg-white px-2 py-1">
            <RoadRangeBar from={roadFrom} to={roadTo} onChange={onRange} />
            <SideSelect value={side} onChange={onSide} />
          </div>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-[#e2e8f0] bg-white p-2">
            <div className="mb-1.5 flex h-6 shrink-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="m-0 text-[13px] font-semibold leading-none text-[#0b1424]">Asset Inventory</h2>
                <span className="truncate text-[11px] text-slate-400">Click a type to plot on map</span>
              </div>
              <p className="m-0 shrink-0 text-[14px] font-semibold tabular-nums text-[#0b1424]">
                {inventory.total.toLocaleString()}
                <span className="ml-1 text-[11px] font-medium text-slate-500">assets · {inventory.types.length} types</span>
              </p>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[repeat(10,minmax(0,1fr))] gap-1 sm:grid-cols-4 sm:grid-rows-[repeat(5,minmax(0,1fr))] xl:grid-cols-5 xl:grid-rows-[repeat(4,minmax(0,1fr))]">
              {sortedTypes(inventory.types).map((t) => (
                <CountCard
                  key={t.id}
                  type={t}
                  selected={mapAsset === t.id}
                  onSelect={(id) => {
                    onMapAsset?.(mapAsset === id ? null : id)
                    onDistressFocus?.(null)
                  }}
                />
              ))}
            </div>
          </section>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-[#e2e8f0] bg-white p-2">
            <div className="mb-1.5 flex h-6 shrink-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="m-0 text-[13px] font-semibold leading-none text-[#0b1424]">Road Distress Analysis</h2>
                <span className="truncate text-[11px] text-slate-400">Filter by side or type</span>
              </div>
              <p className="m-0 shrink-0 text-[13px] font-semibold tabular-nums text-slate-500">{distressTotal} records</p>
            </div>
            <div className={`grid min-h-0 flex-1 gap-1 ${distress.length > 2 ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'}`}>
              {distress.map((g) => (
                <DistressCard
                  key={g.id}
                  group={g}
                  selected={distressFocus?.group === g.id}
                  selectedType={distressFocus?.group === g.id ? distressFocus.type : null}
                  onSelect={(id) => {
                    onMapAsset?.(null)
                    onDistressFocus?.(distressFocus?.group === id && !distressFocus?.type ? null : { group: id })
                  }}
                  onType={(id, name) => {
                    onMapAsset?.(null)
                    onDistressFocus?.(distressFocus?.group === id && distressFocus?.type === name ? null : { group: id, type: name })
                  }}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function CompactProjectRow({ project, open, active, onHover }) {
  return (
    <article
      onMouseEnter={onHover}
      onClick={() => open(project)}
      onKeyDown={(e) => { if (e.key === 'Enter') open(project) }}
      role="button"
      tabIndex={0}
      className={`flex h-[72px] shrink-0 cursor-pointer items-center gap-3 rounded-xl border bg-white p-2 text-left ${
        active ? 'border-[#1d4ed8]' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="pointer-events-none relative h-full w-28 shrink-0 overflow-hidden rounded-lg bg-slate-200 sm:w-40">
        <CorridorMap project={project} from={ROAD_MIN} to={ROAD_MAX} chrome={false} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 truncate text-[14px] font-semibold text-[#0f1f3d]">{project.name}</h2>
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-slate-500">{project.code}</span>
        </div>
        <p className="m-0 mt-0.5 truncate text-[11px] text-slate-500">
          {project.place} · {project.corridor} · {project.km}
        </p>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); open(project) }}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#1d4ed8] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#1e40af]"
      >
        Open hub <IconArrow className="h-3.5 w-3.5" />
      </button>
    </article>
  )
}

export default function ProjectCardsPage() {
  const navigate = useNavigate()
  const { projectQuery = '' } = useOutletContext() || {}
  const last = getStoredProjectId()
  const [activeId, setActiveId] = useState(last)
  const [roadFrom, setRoadFrom] = useState(ROAD_MIN)
  const [roadTo, setRoadTo] = useState(ROAD_MAX)
  const [side, setSide] = useState('both')
  const [mapAsset, setMapAsset] = useState(null)
  const [distressFocus, setDistressFocus] = useState(null)
  const nanasaInventory = useMemo(() => inventoryBetween(roadFrom, roadTo, side), [roadFrom, roadTo, side])
  const nanasaDistress = useMemo(() => distressBetween(roadFrom, roadTo, side), [roadFrom, roadTo, side])
  const list = useMemo(() => {
    const s = projectQuery.trim().toLowerCase()
    return s ? PROJECTS.filter((p) => `${p.name} ${p.subtitle} ${p.code} ${p.corridor} ${p.place}`.toLowerCase().includes(s)) : PROJECTS
  }, [projectQuery])
  const nanasa = list.find((p) => p.name === NANASA_NAME)
  const others = list.filter((p) => p.name !== NANASA_NAME)
  const searching = Boolean(projectQuery.trim())
  const open = (p, extra = {}) => {
    setStoredProjectId(p.id)
    if (p.id === 'adani-nanasa-nprpl') {
      const params = new URLSearchParams()
      const ch = Number.isFinite(Number(extra.chainage)) ? Number(extra.chainage) : roadFrom
      const useSide = extra.side || side
      const useAsset = extra.asset || mapAsset
      if (Number.isFinite(ch)) params.set('ch', String(ch))
      if (useSide === 'inc' || useSide === 'dec') params.set('side', useSide)
      if (useAsset) params.set('asset', useAsset)
      const qs = params.toString()
      navigate(`/workflow/${p.id}${qs ? `?${qs}` : ''}`)
      return
    }
    navigate(`/workflow/${p.id}`)
  }
  const onRange = (a, b) => { setRoadFrom(a); setRoadTo(b) }

  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      {list.length === 0 ? (
        <div className="grid h-full place-items-center text-[14px] text-slate-500">No projects match “{projectQuery}”.</div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {nanasa ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <NanasaDashboard
                project={nanasa}
                open={open}
                roadFrom={roadFrom}
                roadTo={roadTo}
                onRange={onRange}
                side={side}
                onSide={setSide}
                inventory={nanasaInventory}
                distress={nanasaDistress}
                mapAsset={mapAsset}
                onMapAsset={setMapAsset}
                distressFocus={distressFocus}
                onDistressFocus={setDistressFocus}
              />
            </div>
          ) : null}
          {searching && others.length > 0 && (
            <div className="shrink-0 space-y-2 overflow-y-auto border-t border-slate-200 bg-[#eef1f5] p-2">
              {others.map((p) => (
                <CompactProjectRow
                  key={p.id}
                  project={p}
                  open={open}
                  active={p.id === activeId}
                  onHover={() => setActiveId(p.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
