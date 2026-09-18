import { useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import ProjectsMap from './ProjectsMap'
import { IconBack } from './Icons'
import { useWorkflow } from './constants'
import invData from '../../../../../assets/data/adani-inventory.json'
import pmsData from '../../../../../assets/data/adani-pms.json'

const colorOf = (asset) => invData.types.find((t) => t.id === asset)?.color || '#64748b'

function ChainageBar({ items, activeId, activeStart, onPick }) {
  const data = useMemo(() => {
    if (!items.length) return null
    const map = new Map()
    items.forEach((it) => {
      const a = Math.floor(Number(it.start) * 10) / 10
      const b = Math.max(Number(it.end) || a + 0.1, a + 0.1)
      for (let x = a; x < b - 0.001; x += 0.1) {
        const start = Math.round(x * 10) / 10
        const prev = map.get(start)
        if (!prev) map.set(start, { id: it.id, start, end: start + 0.1, color: it.color })
      }
    })
    const bins = [...map.values()].sort((a, b) => a.start - b.start)
    const min = bins[0].start
    const max = bins[bins.length - 1].end
    const span = max - min || 1
    const step = span > 40 ? 10 : 5
    const ticks = [min]
    for (let t = Math.ceil((min + 0.01) / step) * step; t < max - 0.2; t += step) ticks.push(t)
    ticks.push(max)
    return { bins, min, max, span, ticks }
  }, [items])

  if (!data) return null
  const { bins, min, max, span, ticks } = data
  const pct = (ch) => ((ch - min) / span) * 100
  const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? `${Math.round(n)}` : n.toFixed(1))
  const active = bins.find((x) => x.id === activeId) || bins.find((x) => Number(activeStart) >= x.start && Number(activeStart) < x.end)
  const pickAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const ch = min + ((e.clientX - box.left) / box.width) * span
    const hit = bins.find((x) => ch >= x.start && ch < x.end) || bins[bins.length - 1]
    onPick(hit.id)
  }

  return (
    <div className="w-full max-w-[720px] rounded-2xl border border-white/70 bg-white/92 px-3 py-2 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-indigo-400">
        <span>Chainage</span>
        <span className="normal-case tracking-normal text-slate-500">{fmt(min)} – {fmt(max)} km</span>
      </div>
      <div className="relative h-5 cursor-pointer overflow-hidden rounded-full bg-indigo-50" onMouseMove={pickAt} onClick={pickAt}>
        {bins.map((x) => (
          <span key={x.start} className="absolute inset-y-0" style={{ left: `${pct(x.start)}%`, width: `${Math.max(((x.end - x.start) / span) * 100, 0.15)}%`, background: x.color }} />
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

export default function InventoryHubPage() {
  const { redirect, project, base } = useWorkflow()
  const [date, setDate] = useState(invData.dates?.[0] || '')
  const [dir, setDir] = useState('all')
  const [asset, setAsset] = useState('all')
  const [activeId, setActiveId] = useState(null)
  const [hideHud, setHideHud] = useState(false)
  const dirs = useMemo(() => {
    const seen = new Set([...invData.points, ...invData.lines].map((r) => r.dir).filter(Boolean))
    return ['Increasing', 'Decreasing', 'Median'].filter((d) => seen.has(d)).concat([...seen].filter((d) => !['Increasing', 'Decreasing', 'Median'].includes(d)))
  }, [])

  const rows = useMemo(() => {
    const name = project?.name
    return invData.points.filter((r) => {
      if (name && r.project !== name) return false
      if (date && r.date !== date) return false
      if (dir !== 'all' && r.dir !== dir) return false
      if (asset !== 'all' && r.asset !== asset) return false
      return true
    })
  }, [project, date, dir, asset])

  const lineRows = useMemo(() => invData.lines.filter((r) => {
    if (dir !== 'all' && r.dir !== dir) return false
    if (asset !== 'all' && r.asset !== asset) return false
    return true
  }), [dir, asset])

  const points = useMemo(() => rows.map((r) => ({
    ...r,
    id: String(r.i),
    color: colorOf(r.asset),
    name: r.asset,
    place: `${r.dir || '—'} · Ch ${r.start}–${r.end}`,
  })), [rows])

  const segments = useMemo(() => lineRows.map((r) => ({
    ...r,
    id: String(r.i),
    color: colorOf(r.asset),
    weight: 4,
    opacity: 0.78,
    name: r.asset,
    place: `${r.dir || '—'} · Ch ${r.start}–${r.end}`,
  })), [lineRows])

  const counts = useMemo(() => {
    const c = Object.fromEntries((invData.types || []).map((t) => [t.id, 0]))
    const name = project?.name
    invData.points.forEach((r) => {
      if (name && r.project !== name) return
      if (date && r.date !== date) return
      if (dir !== 'all' && r.dir !== dir) return
      if (c[r.asset] != null) c[r.asset] += 1
    })
    invData.lines.forEach((r) => {
      if (dir !== 'all' && r.dir !== dir) return
      if (c[r.asset] != null) c[r.asset] += r.latlngs?.length || 1
    })
    return c
  }, [project, date, dir])
  const barItems = useMemo(() => [...points, ...segments].map((x) => ({ id: x.id, start: x.start, end: x.end, color: x.color })), [points, segments])
  const pavementRecords = useMemo(() => {
    const name = project?.name
    const latest = pmsData.dates?.[0]
    return pmsData.records.filter((r) => {
      if (name && r.project !== name) return false
      if (latest && r.date !== latest) return false
      return true
    })
  }, [project])
  const active = points.find((p) => p.id === activeId) || segments.find((s) => s.id === activeId) || points[0] || segments[0]
  const total = Object.values(counts).reduce((n, v) => n + v, 0)

  if (redirect) return <Navigate to={redirect} replace />

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {points.length || segments.length ? (
        <ProjectsMap
          points={points}
          segments={segments}
          activeId={active?.id}
          onHover={setActiveId}
          onSelect={(s) => setActiveId(s.id)}
          maxZoom={15}
          pad={[[20, 88], [360, 150]]}
          enable3dRoad
          inventoryPoints={points}
          inventoryLines={segments}
          pavementRecords={pavementRecords}
          on3dModalChange={setHideHud}
        />
      ) : (
        <div className="grid h-full place-items-center text-[14px] text-slate-500">No inventory assets for this filter.</div>
      )}

      {!hideHud && (
      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute left-16 top-3">
          <Link to={base} className="inline-flex h-10 items-center gap-1.5 rounded-full border border-white/70 bg-white/92 px-3 text-[13px] text-indigo-950 no-underline shadow-lg backdrop-blur hover:border-indigo-300">
            <IconBack className="h-4 w-4" /> Back
          </Link>
        </div>

        <aside className="pointer-events-auto absolute bottom-4 right-4 top-3 flex w-[min(340px,38vw)] flex-col overflow-hidden rounded-3xl border border-white/70 bg-white/92 p-3 shadow-[0_20px_50px_rgba(30,27,75,0.16)] backdrop-blur">
          <div className="mb-2 shrink-0">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-500">Inventory</p>
            <h1 className="m-0 text-[18px] font-semibold tracking-tight text-indigo-950">Asset register</h1>
            <p className="m-0 truncate text-[12px] text-slate-500">{project.name} · {asset === 'all' ? total : (counts[asset] || 0)} assets</p>
          </div>
          <div className="mb-2 grid shrink-0 grid-cols-2 gap-2">
            <select value={date} onChange={(e) => setDate(e.target.value)} className="h-9 rounded-xl border border-indigo-100 bg-white px-2 text-[12px] text-indigo-950 outline-none">
              {(invData.dates || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={dir} onChange={(e) => setDir(e.target.value)} className="h-9 rounded-xl border border-indigo-100 bg-white px-2 text-[12px] text-indigo-950 outline-none">
              <option value="all">All directions</option>
              {dirs.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <p className="mb-2 mt-0 shrink-0 text-[12px] text-slate-400">Asset type · click to filter</p>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
            <button type="button" onClick={() => setAsset('all')} className={`rounded-2xl border px-3 py-2 text-left text-[13px] ${asset === 'all' ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-100 bg-white'}`}>All assets · {total}</button>
            {invData.types.map((t) => (
              <button key={t.id} type="button" onClick={() => setAsset(t.id)} className={`flex items-center gap-3 rounded-2xl border px-3 py-2 text-left ${asset === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-100 bg-white hover:border-indigo-300'}`}>
                <span className="h-3 w-8 shrink-0 rounded-full" style={{ background: t.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-indigo-950">{t.id}</span>
                  <span className="block text-[11px] text-slate-500">{t.kind === 'line' ? 'Linear asset' : 'Point asset'}</span>
                </span>
                <span className="text-[12px] font-semibold text-indigo-400">{counts[t.id] || 0}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="pointer-events-none absolute bottom-4 left-4 right-[min(356px,38vw)] flex flex-col items-center gap-2">
          {active && (
            <div className="pointer-events-auto rounded-2xl border border-white/70 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
              <p className="m-0 text-[13px] font-semibold text-indigo-950">{active.name} · {active.place}</p>
              <p className="m-0 text-[12px] text-slate-500">{active.dir || '—'} {active.date ? `· ${active.date}` : ''}</p>
            </div>
          )}
          <div className="pointer-events-auto w-full max-w-[720px]">
            <ChainageBar items={barItems} activeId={active?.id} activeStart={active?.start} onPick={setActiveId} />
          </div>
        </div>
      </div>
      )}
    </div>
  )
}
