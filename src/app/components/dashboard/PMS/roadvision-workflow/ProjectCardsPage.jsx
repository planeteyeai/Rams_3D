import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import medianData from '../../../../../assets/data/nanasa-median.json'
import invData from '../../../../../assets/data/adani-inventory.json'
import reportedData from '../../../../../assets/data/adani-reported.json'
import { IconArrow, IconSearch } from './Icons'
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
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [95, 142.94]
  return [Math.floor(min * 100) / 100, Math.ceil(max * 100) / 100]
}
const [ROAD_MIN, ROAD_MAX] = roadEnds()

const fullInventory = () => {
  const types = invData.types || []
  return { total: types.reduce((n, t) => n + (t.n || 0), 0), types }
}

/** Inventory whose chainage overlaps the selected stretch of road. */
function inventoryBetween(from, to) {
  if (from <= ROAD_MIN + 0.001 && to >= ROAD_MAX - 0.001) return fullInventory()
  const tally = Object.fromEntries((invData.types || []).map((t) => [t.id, 0]))
  ;(invData.points || []).forEach((p) => {
    const a = Number(p.start)
    const b = Number(p.end ?? p.start)
    if (b > from && a < to) tally[p.asset] = (tally[p.asset] || 0) + 1
  })
  ;(invData.lines || []).forEach((l) => {
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
  { id: 'LHS', label: 'LHS', hint: 'Increasing', road: 'main', dir: 'inc', color: '#059669' },
  { id: 'RHS', label: 'RHS', hint: 'Decreasing', road: 'main', dir: 'dec', color: '#2563eb' },
  { id: 'sinc', label: 'S Increasing', hint: 'Service road', road: 'service', dir: 'inc', color: '#d97706' },
  { id: 'sdec', label: 'S Decreasing', hint: 'Service road', road: 'service', dir: 'dec', color: '#7c3aed' },
]

const DISTRESS_TYPES = ['Cracking', 'Raveling', 'Settlement', 'Pothole', 'Faulting', 'Bleeding']

function distressBetween(from, to) {
  const groups = DISTRESS_SIDES.map((side) => ({
    ...side,
    total: 0,
    types: Object.fromEntries(DISTRESS_TYPES.map((name) => [name, 0])),
  }))
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]))
  ;(reportedData.records || []).forEach((r) => {
    const a = Number(r.chainage_start)
    const b = Number(r.chainage_end ?? r.chainage_start)
    if (!(b > from && a < to)) return
    const service = String(r.road || '').toLowerCase() === 'service'
    const inc = String(r.direction || '').toLowerCase().startsWith('inc')
    const id = service ? (inc ? 'sinc' : 'sdec') : (inc ? 'LHS' : 'RHS')
    const group = byId[id]
    if (!group) return
    group.total += 1
    const kind = r.distress_type || 'Distress'
    group.types[kind] = (group.types[kind] || 0) + 1
  })
  return groups
}

function RoadRangeBar({ from, to, onChange, holdOpen }) {
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
      window.setTimeout(() => { if (holdOpen) holdOpen.current = false }, 0)
    }
    if (holdOpen) holdOpen.current = true
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className="min-w-[240px] flex-1 px-2"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between text-[12px] font-semibold text-indigo-950">
        <span>Ch {from.toFixed(2)} km</span>
        <span className="text-slate-400">{(to - from).toFixed(2)} km</span>
        <span>Ch {to.toFixed(2)} km</span>
      </div>
      <div ref={track} className="relative h-3 rounded-full bg-slate-200">
        <div
          className="absolute inset-y-0 rounded-full bg-indigo-600"
          style={{ left: `${pct(from)}%`, width: `${Math.max(pct(to) - pct(from), 0)}%` }}
        />
        {['from', 'to'].map((edge) => (
          <button
            key={edge}
            type="button"
            aria-label={edge === 'from' ? 'Road range start' : 'Road range end'}
            onPointerDown={(e) => drag(edge, e)}
            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-indigo-600 shadow"
            style={{ left: `${pct(edge === 'from' ? from : to)}%` }}
          />
        ))}
      </div>
    </div>
  )
}

function ProjectMiniMap({ project, from, to }) {
  const ref = useRef(null)
  const mapRef = useRef(null)
  const hiRef = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const m = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
    })
    L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
      maxZoom: 18,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    }).addTo(m)
    if (project.id === 'adani-nanasa-nprpl' && NANASA_LINE.length > 1) {
      L.polyline(NANASA_LINE, { color: '#ffffff', weight: 2, opacity: 0.35 }).addTo(m)
      hiRef.current = L.polyline(lineBetween(from ?? ROAD_MIN, to ?? ROAD_MAX), {
        color: '#ffffff',
        weight: 5,
        opacity: 1,
      }).addTo(m)
      m.fitBounds(hiRef.current.getBounds(), { padding: [16, 16] })
    } else {
      L.circleMarker([project.lat, project.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#4f46e5',
        fillOpacity: 1,
      }).addTo(m)
      m.setView([project.lat, project.lng], 11)
    }
    mapRef.current = m
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el)
    const t = setTimeout(() => m.invalidateSize(), 80)
    return () => {
      clearTimeout(t)
      ro.disconnect()
      m.remove()
      mapRef.current = null
      hiRef.current = null
    }
  }, [project])
  useEffect(() => {
    const m = mapRef.current
    const hi = hiRef.current
    if (!m || !hi || project.id !== 'adani-nanasa-nprpl') return
    const pts = lineBetween(from, to)
    hi.setLatLngs(pts)
    if (pts.length > 1) m.fitBounds(hi.getBounds(), { padding: [16, 16], animate: false })
  }, [from, to, project.id])
  return <div ref={ref} className="h-full w-full" />
}

function CountCard({ label, value, color, strong }) {
  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col justify-center rounded-lg border px-2 py-1 ${strong ? 'border-indigo-200 bg-indigo-50' : 'border-indigo-100 bg-white'}`}>
      <span className="truncate text-[13px] font-medium leading-tight text-slate-500">{label}</span>
      <span className="truncate text-[22px] font-semibold tabular-nums leading-tight text-indigo-950">{Number(value).toLocaleString()}</span>
      {color && <span className="mt-1 h-0.5 w-6 rounded-full" style={{ background: color }} />}
    </div>
  )
}

export default function ProjectCardsPage() {
  const navigate = useNavigate()
  const last = getStoredProjectId()
  const [q, setQ] = useState('')
  const [activeId, setActiveId] = useState(last)
  const [roadFrom, setRoadFrom] = useState(ROAD_MIN)
  const [roadTo, setRoadTo] = useState(ROAD_MAX)
  const skipOpen = useRef(false)
  const nanasaInventory = useMemo(() => inventoryBetween(roadFrom, roadTo), [roadFrom, roadTo])
  const nanasaDistress = useMemo(() => distressBetween(roadFrom, roadTo), [roadFrom, roadTo])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? PROJECTS.filter((p) => `${p.name} ${p.subtitle} ${p.code} ${p.corridor} ${p.place}`.toLowerCase().includes(s)) : PROJECTS
  }, [q])
  const open = (p) => { setStoredProjectId(p.id); navigate(`/workflow/${p.id}`) }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#eef2ff]">
      <div className="flex shrink-0 items-center justify-between gap-4 px-3 py-2">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-500">Projects</p>
          <h1 className="m-0 text-[18px] font-semibold tracking-tight text-indigo-950">Select a project</h1>
        </div>
        <label className="flex h-9 w-[min(360px,40vw)] shrink-0 items-center gap-2 rounded-xl border border-indigo-100 bg-white px-3 text-[13px] text-indigo-950 shadow-sm focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-100">
          <IconSearch className="h-4 w-4 text-indigo-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) open(list[0]) }}
            placeholder="Search projects"
            className="min-w-0 flex-1 border-0 bg-transparent outline-none placeholder:text-slate-400"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {list.length === 0 ? (
          <div className="grid h-full place-items-center text-[14px] text-slate-500">No projects match “{q}”.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {list.map((p) => {
              const on = p.id === activeId
              const inv = p.name === NANASA_NAME ? nanasaInventory : { total: 0, types: [] }
              const counts = [{ id: 'Inventory', n: inv.total, strong: true }, ...inv.types.map((t) => ({ id: t.id, n: t.n, color: t.color }))]
              const cols = Math.min(8, Math.max(counts.length, 1))
              const rows = Math.max(1, Math.ceil(counts.length / cols))
              const openLabel = p.id === 'adani-nanasa-nprpl' ? 'Open 3D' : 'Open hub'
              const detailed = inv.types.length > 0
              return (
                <article
                  key={p.id}
                  onMouseEnter={() => setActiveId(p.id)}
                  onClick={() => { if (skipOpen.current) return; open(p) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(p) }}
                  role="button"
                  tabIndex={0}
                  className={`flex w-full shrink-0 cursor-pointer gap-3 overflow-hidden rounded-2xl border bg-white p-2 text-left shadow-sm transition ${detailed ? 'h-[40rem]' : 'h-28'} ${on ? 'border-indigo-500 shadow-[0_10px_28px_rgba(67,56,202,0.12)]' : 'border-indigo-100 hover:border-indigo-300'}`}
                >
                  <div className="pointer-events-none relative h-full w-[min(420px,34vw)] shrink-0 overflow-hidden rounded-xl bg-slate-200">
                    <ProjectMiniMap project={p} from={detailed ? roadFrom : undefined} to={detailed ? roadTo : undefined} />
                    <span className="absolute bottom-1 right-1.5 text-[9px] font-medium text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">© Google</span>
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 py-0.5 pr-1">
                    <div className="flex shrink-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className={`m-0 truncate font-semibold leading-tight text-indigo-950 ${detailed ? 'text-[22px]' : 'text-[15px]'}`}>{p.name}</h2>
                          <span className={`shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 font-bold tracking-wider text-indigo-500 ${detailed ? 'text-[13px]' : 'text-[10px]'}`}>{p.code}</span>
                        </div>
                        <p className={`m-0 truncate leading-tight text-slate-500 ${detailed ? 'text-[15px]' : 'text-[12px]'}`}>
                          {p.place} · {p.corridor} · {p.km}
                          {!detailed && <span className="text-slate-400"> · Inventory 0</span>}
                        </p>
                      </div>
                      {detailed && (
                        <RoadRangeBar from={roadFrom} to={roadTo} holdOpen={skipOpen} onChange={(a, b) => { setRoadFrom(a); setRoadTo(b) }} />
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); open(p) }}
                        className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-600 font-semibold text-white hover:bg-indigo-500 ${detailed ? 'px-4 py-2 text-[14px]' : 'px-3 py-1.5 text-[12px]'}`}
                      >
                        {openLabel} <IconArrow className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {detailed ? (
                      <div
                        className="grid min-h-0 flex-1 gap-1.5 overflow-hidden"
                        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
                      >
                        {counts.map((t) => (
                          <CountCard key={t.id} label={t.id} value={t.n} color={t.color} strong={t.strong} />
                        ))}
                      </div>
                    ) : null}
                    {detailed && (
                      <div className="grid h-44 shrink-0 grid-cols-4 gap-1.5">
                        {nanasaDistress.map((g) => (
                          <div key={g.id} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-indigo-100 bg-white px-2 py-1.5">
                            <div className="flex items-baseline justify-between gap-1">
                              <span className="truncate text-[13px] font-bold" style={{ color: g.color }}>{g.label}</span>
                              <span className="text-[18px] font-semibold tabular-nums text-indigo-950">{g.total}</span>
                            </div>
                            <p className="m-0 truncate text-[11px] text-slate-400">{g.hint}</p>
                            <div className="mt-1 flex min-h-0 flex-1 flex-col justify-between">
                              {DISTRESS_TYPES.map((name) => (
                                <div key={name} className="flex items-center justify-between gap-2 text-[12px] leading-tight">
                                  <span className="truncate text-slate-500">{name}</span>
                                  <span className="font-semibold tabular-nums text-indigo-950">{g.types[name] || 0}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
