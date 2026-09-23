import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import medianData from '../../../../../assets/data/nanasa-median.json'
import { buildCorridorPolygons, snapLatLngToRoad } from './road3dGeometry'
import NanasaRoad3DModal from './NanasaRoad3DModal'

const CHAINAGE_MIN_KM = 95
const CHAINAGE_MAX_KM = 142.94
const SNAP_MAX_M = 450

const pin = (p, on) => L.divIcon({
  className: 'map-pin-wrap',
  iconSize: [40, 40],
  iconAnchor: [20, 40],
  html: `<span class="map-pin${on ? ' is-on' : ''}${p.tone ? ` ${p.tone}` : ''}">${p.code}</span>`,
})

const BASES = [
  { id: 'streets', label: 'Streets', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap' },
  { id: 'satellite', label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Tiles &copy; Esri' },
  { id: 'terrain', label: 'Terrain', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', attr: 'Tiles &copy; Esri' },
]

const NONE = []

export default function ProjectsMap({
  projects = NONE,
  segments = NONE,
  points = NONE,
  activeId,
  onHover,
  onSelect,
  maxZoom = 8,
  pad,
  enable3dRoad = false,
  inventoryPoints = NONE,
  inventoryLines = NONE,
  pavementRecords = NONE,
  pavementDate = '',
  on3dModalChange,
}) {
  const wrap = useRef(null)
  const map = useRef(null)
  const marks = useRef({})
  const lines = useRef({})
  const halos = useRef({})
  const dots = useRef({})
  const tiles = useRef({})
  const canvas = useRef(null)
  const road3dLayer = useRef(null)
  const lastActive = useRef(null)
  const hover = useRef(onHover)
  const select = useRef(onSelect)
  const opt = useRef({ maxZoom, pad })
  const userView = useRef(false)
  const [base, setBase] = useState('streets')
  const [show3dLayer, setShow3dLayer] = useState(false)
  const [show3dModal, setShow3dModal] = useState(false)
  const [entry3d, setEntry3d] = useState({ key: 0, chainageKm: null, pathMode: null })
  const [pegDrag, setPegDrag] = useState(null) // { x, y } viewport coords while dragging
  const [pegHint, setPegHint] = useState('')
  const snapPreview = useRef(null)
  const pegActive = useRef(false)
  hover.current = onHover
  select.current = onSelect
  opt.current = { maxZoom, pad }

  const fit = (m, force = false) => {
    if (!force && userView.current) return
    const pts = [
      ...Object.values(marks.current).map((mk) => mk.getLatLng()),
      ...Object.values(dots.current).map((mk) => mk.getLatLng()),
      ...Object.values(lines.current).flatMap((l) => l.getLatLngs().flat()),
    ]
    if (road3dLayer.current && m.hasLayer(road3dLayer.current)) {
      try {
        const b = road3dLayer.current.getBounds()
        if (b.isValid()) {
          pts.push(b.getSouthWest(), b.getNorthEast())
        }
      } catch {
        /* ignore */
      }
    }
    if (!pts.length) return
    const { maxZoom: z, pad: p } = opt.current
    m.fitBounds(pts, { paddingTopLeft: p?.[0] || [20, 88], paddingBottomRight: p?.[1] || [360, 88], maxZoom: z })
  }

  const showBase = (id) => {
    const m = map.current
    if (!m || !tiles.current[id]) return
    Object.entries(tiles.current).forEach(([k, t]) => (k === id ? t.addTo(m) : m.removeLayer(t)))
    setBase(id)
  }

  const clearRoad3d = () => {
    const m = map.current
    if (m && road3dLayer.current) {
      m.removeLayer(road3dLayer.current)
      road3dLayer.current = null
    }
  }

  const drawRoad3d = (fitView = false) => {
    const m = map.current
    if (!m || !enable3dRoad) return
    clearRoad3d()
    const poly = buildCorridorPolygons(medianData.coordinates)
    const group = L.layerGroup()
    L.polygon(poly.decreasing, {
      color: '#111827',
      weight: 1,
      fillColor: '#374151',
      fillOpacity: 0.55,
      interactive: false,
    }).addTo(group)
    L.polygon(poly.median, {
      color: '#166534',
      weight: 1,
      fillColor: '#4ade80',
      fillOpacity: 0.45,
      interactive: false,
    }).addTo(group)
    L.polygon(poly.increasing, {
      color: '#111827',
      weight: 1,
      fillColor: '#1f2937',
      fillOpacity: 0.55,
      interactive: false,
    }).addTo(group)
    L.polyline(poly.centerline, {
      color: '#fbbf24',
      weight: 2,
      opacity: 0.95,
      dashArray: '6 4',
      interactive: false,
    }).addTo(group)
    group.addTo(m)
    road3dLayer.current = group
    if (fitView) {
      userView.current = false
      fit(m, true)
    }
  }

  useEffect(() => {
    const m = L.map(wrap.current, { zoomControl: false, scrollWheelZoom: true })
    canvas.current = L.canvas({ padding: 0.5 })
    tiles.current = Object.fromEntries(BASES.map((b) => [b.id, L.tileLayer(b.url, { attribution: b.attr, maxZoom: 19 })]))
    tiles.current.streets.addTo(m)
    L.control.zoom({ position: 'topleft' }).addTo(m)
    const keepView = () => { userView.current = true }
    m.on('zoomstart dragstart', keepView)
    map.current = m
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(wrap.current)
    const t = setTimeout(() => m.invalidateSize(), 150)
    return () => {
      clearTimeout(t)
      ro.disconnect()
      m.off('zoomstart dragstart', keepView)
      clearRoad3d()
      m.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    Object.values(marks.current).forEach((mk) => mk.remove())
    marks.current = {}
    projects.forEach((p) => {
      const mk = L.marker([p.lat, p.lng], { icon: pin(p, false), riseOnHover: true }).addTo(m)
      mk.on('click', () => select.current?.(p))
      mk.on('mouseover', () => hover.current?.(p.id))
      marks.current[p.id] = mk
    })
    if (projects.length) {
      userView.current = false
      fit(m, true)
    }
  }, [projects])

  useEffect(() => {
    const m = map.current
    if (!m) return
    Object.values(lines.current).forEach((l) => l.remove())
    Object.values(halos.current).forEach((l) => l.remove())
    lines.current = {}
    halos.current = {}
    segments.forEach((s) => {
      const w = s.weight || 6
      const light = /^#fff(fff)?$/i.test(s.color)
      if (light) {
        halos.current[s.id] = L.polyline(s.latlngs, { color: '#111827', weight: w + 3, opacity: 0.95, lineCap: 'butt', interactive: false }).addTo(m)
      }
      const line = L.polyline(s.latlngs, { color: s.color, weight: w, opacity: s.opacity || 0.92, lineCap: 'butt' }).addTo(m)
      line.on('click', () => select.current?.(s))
      line.on('mouseover', () => hover.current?.(s.id))
      lines.current[s.id] = line
    })
    if (segments.length) {
      userView.current = false
      fit(m, true)
    }
  }, [segments])

  useEffect(() => {
    const m = map.current
    if (!m) return
    Object.values(dots.current).forEach((mk) => mk.remove())
    dots.current = {}
    points.forEach((p) => {
      const mk = L.circleMarker([p.lat, p.lng], {
        renderer: canvas.current || undefined,
        radius: 6,
        color: '#fff',
        weight: 1,
        fillColor: p.color,
        fillOpacity: 0.92,
      }).addTo(m)
      mk.on('click', () => select.current?.(p))
      mk.on('mouseover', () => hover.current?.(p.id))
      dots.current[p.id] = mk
    })
    if (points.length) {
      userView.current = false
      fit(m, true)
    }
  }, [points])

  useEffect(() => {
    const prev = lastActive.current
    if (prev && prev !== activeId) {
      const mk = marks.current[prev]
      const p = mk && projects.find((x) => x.id === prev)
      if (p) mk.setIcon(pin(p, false))
      if (lines.current[prev]) lines.current[prev].setStyle({ weight: (segments.find((s) => s.id === prev)?.weight) || 6, opacity: 0.88 })
      if (dots.current[prev]) dots.current[prev].setStyle({ radius: 6, weight: 1 })
    }
    if (activeId) {
      const p = projects.find((x) => x.id === activeId)
      if (p && marks.current[activeId]) marks.current[activeId].setIcon(pin(p, true))
      if (lines.current[activeId]) {
        lines.current[activeId].setStyle({ weight: 9, opacity: 1 })
        lines.current[activeId].bringToFront()
      }
      if (dots.current[activeId]) {
        dots.current[activeId].setStyle({ radius: 9, weight: 2 })
        dots.current[activeId].bringToFront()
      }
    }
    lastActive.current = activeId
  }, [activeId, projects, segments])

  useEffect(() => {
    if (!enable3dRoad) {
      clearRoad3d()
      setShow3dLayer(false)
      setShow3dModal(false)
      return
    }
    if (show3dLayer) drawRoad3d(true)
    else clearRoad3d()
  }, [show3dLayer, enable3dRoad])

  const toggle3dLayer = () => {
    setShow3dLayer((v) => {
      const next = !v
      if (next) setShow3dModal(true)
      else setShow3dModal(false)
      return next
    })
  }

  useEffect(() => {
    on3dModalChange?.(show3dModal)
  }, [show3dModal, on3dModalChange])

  const clearSnapPreview = () => {
    const m = map.current
    if (m && snapPreview.current) {
      m.removeLayer(snapPreview.current)
      snapPreview.current = null
    }
  }

  const updateSnapPreview = (latlng) => {
    const m = map.current
    if (!m || !latlng) return
    const snap = snapLatLngToRoad(
      latlng.lat,
      latlng.lng,
      medianData.coordinates,
      CHAINAGE_MIN_KM,
      CHAINAGE_MAX_KM,
      SNAP_MAX_M,
    )
    clearSnapPreview()
    if (!snap) {
      setPegHint('Drop on the Nanasa corridor')
      return null
    }
    const icon = L.divIcon({
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      html: `<div style="width:28px;height:28px;border-radius:999px;border:3px solid #fff;background:${snap.pathMode === 'lhs' ? '#22c55e' : snap.pathMode === 'rhs' ? '#3b82f6' : '#f59e0b'};box-shadow:0 2px 10px rgba(0,0,0,.35)"></div>`,
    })
    snapPreview.current = L.marker([snap.lat, snap.lng], { icon, interactive: false, zIndexOffset: 2000 }).addTo(m)
    const side = snap.pathMode === 'lhs' ? 'LHS' : snap.pathMode === 'rhs' ? 'RHS' : 'Median'
    setPegHint(`${side} · Ch ${snap.chainageKm.toFixed(2)} km`)
    return snap
  }

  const open3dAt = (snap) => {
    if (!snap) return
    setShow3dLayer(true)
    setEntry3d((prev) => ({
      key: prev.key + 1,
      chainageKm: snap.chainageKm,
      pathMode: snap.pathMode,
    }))
    setShow3dModal(true)
    setPegHint('')
  }

  const onPegPointerDown = (e) => {
    if (!enable3dRoad || show3dModal) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const m = map.current
    if (m) m.dragging.disable()
    if (!show3dLayer) setShow3dLayer(true)
    pegActive.current = true
    setPegDrag({ x: e.clientX, y: e.clientY })
    setPegHint('Drop on the road to open 3D')
  }

  const finishPegDrag = (clientX, clientY) => {
    if (!pegActive.current) return
    pegActive.current = false
    const m = map.current
    const el = wrap.current
    if (m) m.dragging.enable()
    let snap = null
    if (m && el) {
      const rect = el.getBoundingClientRect()
      const pt = L.point(clientX - rect.left, clientY - rect.top)
      const latlng = m.containerPointToLatLng(pt)
      snap = updateSnapPreview(latlng)
    }
    clearSnapPreview()
    setPegDrag(null)
    if (snap) open3dAt(snap)
    else setPegHint('Drop closer to the corridor')
  }

  useEffect(() => {
    if (!pegDrag) return undefined
    const move = (ev) => {
      if (!pegActive.current) return
      setPegDrag({ x: ev.clientX, y: ev.clientY })
      const m = map.current
      const el = wrap.current
      if (!m || !el) return
      const rect = el.getBoundingClientRect()
      const pt = L.point(ev.clientX - rect.left, ev.clientY - rect.top)
      updateSnapPreview(m.containerPointToLatLng(pt))
    }
    const up = (ev) => finishPegDrag(ev.clientX, ev.clientY)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [pegDrag]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`absolute inset-0 h-full w-full ${show3dModal ? 'z-[1100]' : 'z-[450]'}`}>
      <div ref={wrap} className="absolute inset-0" />
      {!show3dModal && (
      <div className="absolute left-3 top-[8.5rem] z-[1000] flex flex-col overflow-hidden rounded-xl border border-white/80 bg-white/92 shadow-lg backdrop-blur">
        {BASES.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => showBase(b.id)}
            className={`px-3 py-1.5 text-left text-[12px] font-semibold transition ${base === b.id ? 'bg-indigo-600 text-white' : 'text-indigo-950 hover:bg-indigo-50'}`}
          >
            {b.label}
          </button>
        ))}
        {enable3dRoad && (
          <>
            <button
              type="button"
              onClick={toggle3dLayer}
              className={`border-t border-indigo-100 px-3 py-1.5 text-left text-[12px] font-semibold transition ${show3dLayer ? 'bg-emerald-600 text-white' : 'text-indigo-950 hover:bg-indigo-50'}`}
            >
              3D Model layer
            </button>
            {show3dLayer && (
              <button
                type="button"
                onClick={() => {
                  setEntry3d((prev) => ({ ...prev, key: prev.key + 1 }))
                  setShow3dModal(true)
                }}
                className="px-3 py-1.5 text-left text-[12px] font-semibold text-indigo-950 transition hover:bg-indigo-50"
              >
                Open 3D view
              </button>
            )}
          </>
        )}
      </div>
      )}

      {/* Pegman-style control — left side so inventory panel does not cover it */}
      {enable3dRoad && !show3dModal && (
        <div className="pointer-events-none absolute bottom-28 left-3 z-[1000] flex flex-col items-start gap-2">
          {pegHint ? (
            <div className="max-w-[200px] rounded-lg border border-white/70 bg-slate-900/90 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-lg backdrop-blur">
              {pegHint}
            </div>
          ) : (
            <div className="max-w-[160px] rounded-lg border border-indigo-100 bg-white/95 px-2 py-1 text-[10px] font-semibold text-indigo-800 shadow">
              Drag onto road → 3D
            </div>
          )}
          <button
            type="button"
            onPointerDown={onPegPointerDown}
            title="Drag onto the road to open 3D view at that point"
            aria-label="Drag 3D view peg onto the road"
            className={`pointer-events-auto flex h-16 w-14 cursor-grab flex-col items-center justify-end rounded-2xl border-2 border-amber-300 bg-white pb-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.25)] active:cursor-grabbing ${pegDrag ? 'opacity-30' : 'hover:scale-105 hover:bg-amber-50'}`}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-400 text-slate-900 shadow-md" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
                <circle cx="12" cy="5" r="2.2" />
                <path d="M12 8.2c-1.6 0-2.8 1.1-2.8 2.6v3.2l-1.5 5.2h1.7l1.3-4.4h.6l1.3 4.4h1.7l-1.5-5.2v-3.2c0-1.5-1.2-2.6-2.8-2.6z" />
              </svg>
            </span>
            <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-950">3D</span>
          </button>
        </div>
      )}

      {pegDrag && (
        <div
          className="pointer-events-none fixed z-[3000] -translate-x-1/2 -translate-y-[90%]"
          style={{ left: pegDrag.x, top: pegDrag.y }}
        >
          <div className="flex flex-col items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border-[3px] border-white bg-amber-400 shadow-2xl">
              <svg viewBox="0 0 24 24" className="h-7 w-7 text-slate-900" fill="currentColor">
                <circle cx="12" cy="5" r="2.2" />
                <path d="M12 8.2c-1.6 0-2.8 1.1-2.8 2.6v3.2l-1.5 5.2h1.7l1.3-4.4h.6l1.3 4.4h1.7l-1.5-5.2v-3.2c0-1.5-1.2-2.6-2.8-2.6z" />
              </svg>
            </div>
            <div className="mt-1 h-2 w-2 rotate-45 bg-amber-400 shadow" />
          </div>
        </div>
      )}

      {enable3dRoad && (
        <NanasaRoad3DModal
          open={show3dModal}
          onClose={() => setShow3dModal(false)}
          inventoryPoints={inventoryPoints}
          inventoryLines={inventoryLines}
          pavementRecords={pavementRecords}
          pavementDate={pavementDate}
          initialChainageKm={entry3d.chainageKm}
          initialPathMode={entry3d.pathMode}
          entryKey={entry3d.key}
        />
      )}
    </div>
  )
}
