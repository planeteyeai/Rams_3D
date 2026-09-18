import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import ProjectsMap from './ProjectsMap'
import { IconBack } from './Icons'
import { setStoredPavementType, useWorkflow } from './constants'
import pmsData from '../../../../../assets/data/adani-pms.json'
import invData from '../../../../../assets/data/adani-inventory.json'

const IRI = [
  { id: 'good', label: 'Good', color: '#000000' },
  { id: 'fair', label: 'Fair', color: '#FACC15' },
  { id: 'poor', label: 'Poor', color: '#FFFFFF' },
]

const iriMeta = (id) => IRI.find((x) => x.id === id) || { id, label: 'N/A', color: '#94a3b8' }
const iriCap = (pavement) => (pavement === 'concrete' ? 2 : 1.8)
const iriCapLabel = (pavement) => (pavement === 'concrete' ? '2000' : '1800')
const iriBand = (r) => {
  const v = Number(r.iri)
  if (!Number.isFinite(v)) return 'na'
  if (v < iriCap(r.pavement)) return 'good'
  if (v <= 2.4) return 'fair'
  return 'poor'
}
function ChainageBar({ rows, activeId, activeStart, onPick }) {
  const data = useMemo(() => {
    if (!rows.length) return null
    const rank = { poor: 3, fair: 2, good: 1, na: 0 }
    const map = new Map()
    rows.forEach((r) => {
      const k = `${r.start}-${r.end}`
      const band = iriBand(r)
      const prev = map.get(k)
      if (!prev || (rank[band] || 0) > (rank[prev.band] || 0)) {
        map.set(k, { id: String(r.i), start: Number(r.start), end: Number(r.end), color: iriMeta(band).color, band })
      }
    })
    const items = [...map.values()].sort((a, b) => a.start - b.start)
    const min = items[0].start
    const max = items[items.length - 1].end
    const span = max - min || 1
    const step = span > 40 ? 10 : 5
    const ticks = [min]
    for (let t = Math.ceil((min + 0.01) / step) * step; t < max - 0.2; t += step) ticks.push(t)
    ticks.push(max)
    return { items, min, max, span, ticks }
  }, [rows])

  if (!data) return null
  const { items, min, max, span, ticks } = data
  const active = items.find((x) => x.id === activeId) || items.find((x) => Number(activeStart) >= x.start && Number(activeStart) < x.end)
  const pct = (ch) => ((ch - min) / span) * 100
  const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? `${Math.round(n)}` : n.toFixed(1))
  const pickAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const ch = min + ((e.clientX - box.left) / box.width) * span
    const hit = items.find((x) => ch >= x.start && ch < x.end) || items[items.length - 1]
    onPick(hit.id)
  }

  return (
    <div className="w-full max-w-[720px] rounded-2xl border border-white/70 bg-white/92 px-3 py-2 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-indigo-400">
        <span>Chainage</span>
        <span className="normal-case tracking-normal text-slate-500">{fmt(min)} – {fmt(max)} km</span>
      </div>
      <div className="relative h-5 cursor-pointer overflow-hidden rounded-full bg-indigo-50" onMouseMove={pickAt} onClick={pickAt}>
        {items.map((x) => (
          <span
            key={`${x.start}-${x.end}`}
            className="absolute inset-y-0"
            style={{ left: `${pct(x.start)}%`, width: `${Math.max(((x.end - x.start) / span) * 100, 0.15)}%`, background: x.color, boxShadow: x.color === '#FFFFFF' ? 'inset 0 0 0 1px #94a3b8' : undefined }}
          />
        ))}
        {active && (
          <span className="pointer-events-none absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-indigo-950" style={{ left: `${pct((active.start + active.end) / 2)}%` }} />
        )}
      </div>
      <div className="relative mt-1 h-3">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2 text-[10px] text-slate-500" style={{ left: `${pct(t)}%` }}>{fmt(t)}</span>
        ))}
      </div>
    </div>
  )
}

const iriHints = (id, pavement) => {
  const one = (type) => {
    const cap = iriCapLabel(type)
    if (id === 'good') return `IRI < ${cap}`
    if (id === 'fair') return `IRI ${cap}–2400`
    return 'IRI > 2400'
  }
  if (pavement === 'all') {
    return [
      `Bituminous ${one('bituminous')}`,
      `Concrete ${one('concrete')}`,
    ]
  }
  return [one(pavement)]
}

export default function PmsHubPage() {
  const nav = useNavigate()
  const { redirect, project, base } = useWorkflow()
  const [date, setDate] = useState(pmsData.dates?.[0] || '')
  const [pavement, setPavement] = useState('all')
  const [band, setBand] = useState('all')
  const [activeId, setActiveId] = useState(null)
  const [hideHud, setHideHud] = useState(false)

  const rows = useMemo(() => {
    const name = project?.name
    return pmsData.records.filter((r) => {
      if (name && r.project !== name) return false
      if (date && r.date !== date) return false
      if (pavement !== 'all' && r.pavement !== pavement) return false
      if (band !== 'all' && iriBand(r) !== band) return false
      return true
    })
  }, [project, date, pavement, band])

  const corridor = useMemo(() => {
    const name = project?.name
    return pmsData.records.filter((r) => {
      if (name && r.project !== name) return false
      if (date && r.date !== date) return false
      if (pavement !== 'all' && r.pavement !== pavement) return false
      return true
    })
  }, [project, date, pavement])

  const segments = useMemo(() => rows.map((r) => {
    const from = r.from?.[0] && r.to?.[0] ? [[r.from[0], r.from[1]], [r.to[0], r.to[1]]] : [[r.lat, r.lng], [r.lat, r.lng]]
    const meta = iriMeta(iriBand(r))
    return { id: String(r.i), latlngs: from, color: meta.color, ...r, name: `Ch ${r.start}–${r.end}`, place: meta.label }
  }), [rows])

  const inventoryPoints = useMemo(() => {
    const name = project?.name
    return invData.points
      .filter((r) => (!name || r.project === name) && (!date || !r.date || r.date === date))
      .map((r) => ({
        ...r,
        id: `inv-${r.i}`,
        color: invData.types.find((t) => t.id === r.asset)?.color || '#64748b',
        name: r.asset,
      }))
  }, [project, date])

  const inventoryLines = useMemo(() => invData.lines.map((r) => ({
    ...r,
    id: String(r.i),
    color: invData.types.find((t) => t.id === r.asset)?.color || '#64748b',
    name: r.asset,
  })), [])

  const counts = useMemo(() => {
    const c = Object.fromEntries(IRI.map((x) => [x.id, 0]))
    corridor.forEach((r) => { const id = iriBand(r); if (c[id] != null) c[id] += 1 })
    return c
  }, [corridor])

  const active = segments.find((s) => s.id === activeId) || segments[0]
  if (redirect) return <Navigate to={redirect} replace />
  const pick = (type) => { setStoredPavementType(type); nav(`${base}/pms/${type}`) }

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {segments.length ? (
        <ProjectsMap
          segments={segments}
          activeId={active?.id}
          onHover={setActiveId}
          onSelect={(s) => setActiveId(s.id)}
          maxZoom={18}
          pad={[[20, 88], [360, 150]]}
          enable3dRoad
          inventoryPoints={inventoryPoints}
          inventoryLines={inventoryLines}
          pavementRecords={corridor}
          pavementDate={date}
          on3dModalChange={setHideHud}
        />
      ) : (
        <div className="grid h-full place-items-center text-[14px] text-slate-500">No PMS segments for this filter.</div>
      )}

      {!hideHud && (
      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute left-16 top-3 flex max-w-[min(560px,calc(100%-380px))] items-start gap-2">
          <Link to={base} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/70 bg-white/92 px-3 text-[13px] text-indigo-950 no-underline shadow-lg backdrop-blur hover:border-indigo-300">
            <IconBack className="h-4 w-4" /> Back
          </Link>
          
        </div>

        <aside className="pointer-events-auto absolute bottom-4 right-4 top-3 flex w-[min(340px,38vw)] flex-col overflow-hidden rounded-3xl border border-white/70 bg-white/92 p-3 shadow-[0_20px_50px_rgba(30,27,75,0.16)] backdrop-blur">
          <div className="mb-2 grid shrink-0 grid-cols-2 gap-2">
            <select value={date} onChange={(e) => setDate(e.target.value)} className="h-9 rounded-xl border border-indigo-100 bg-white px-2 text-[12px] text-indigo-950 outline-none">
              {(pmsData.dates || []).map((d) => {
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
                const label = /^\d{4}-\d{2}-\d{2}/.test(d)
                  ? `${d.slice(8, 10)} ${months[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
                  : d
                return <option key={d} value={d}>{label}</option>
              })}
            </select>
            <select value={pavement} onChange={(e) => setPavement(e.target.value)} className="h-9 rounded-xl border border-indigo-100 bg-white px-2 text-[12px] text-indigo-950 outline-none">
              <option value="all">All pavement</option>
              <option value="bituminous">Bituminous</option>
              <option value="concrete">Concrete</option>
            </select>
          </div>
          <p className="mb-2 mt-0 shrink-0 text-[12px] text-slate-400">IRI condition · click to filter</p>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <button type="button" onClick={() => setBand('all')} className={`rounded-2xl border px-3 py-2 text-left text-[13px] ${band === 'all' ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-100 bg-white'}`}>All bands · {rows.length}</button>
            {IRI.map((x) => (
              <button key={x.id} type="button" onClick={() => setBand(x.id)} className={`flex min-h-0 flex-1 items-center gap-3 rounded-2xl border px-3 py-2 text-left ${band === x.id ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-100 bg-white hover:border-indigo-300'}`}>
                <span className="h-3 w-8 shrink-0 rounded-full" style={{ background: x.color, boxShadow: x.color === '#FFFFFF' ? 'inset 0 0 0 1px #94a3b8' : undefined }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-indigo-950">{x.label}</span>
                  {iriHints(x.id, pavement).map((line) => (
                    <span key={line} className="block text-[11px] leading-tight text-slate-500">{line}</span>
                  ))}
                </span>
                <span className="text-[12px] font-semibold text-indigo-400">{counts[x.id]}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 grid shrink-0 grid-cols-2 gap-2">
            <button type="button" onClick={() => pick('bituminous')} className="rounded-xl bg-amber-500 px-2 py-2 text-[12px] font-semibold text-white">Bituminous</button>
            <button type="button" onClick={() => pick('concrete')} className="rounded-xl bg-indigo-600 px-2 py-2 text-[12px] font-semibold text-white">Concrete</button>
          </div>
        </aside>

        <div className="pointer-events-none absolute bottom-4 left-4 right-[min(356px,38vw)] flex flex-col items-center gap-2">
          {active && (
            <div className="pointer-events-auto rounded-2xl border border-white/70 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
              <p className="m-0 text-[13px] font-semibold text-indigo-950">{active.name} km · {active.place}</p>
              <p className="m-0 text-[12px] text-slate-500">{active.pavement} · IRI {active.iri != null ? Number(active.iri).toFixed(2) : '—'} · {active.date}</p>
            </div>
          )}
          <div className="pointer-events-auto w-full max-w-[720px]">
            <ChainageBar rows={corridor} activeId={active?.id} activeStart={active?.start} onPick={setActiveId} />
          </div>
        </div>
      </div>
      )}
    </div>
  )
}
