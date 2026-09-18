import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ProjectsMap from './ProjectsMap'
import { IconArrow, IconRoad, IconSearch } from './Icons'
import { PROJECTS, getStoredProjectId, setStoredProjectId } from './constants'

export default function ProjectCardsPage() {
  const navigate = useNavigate()
  const last = getStoredProjectId()
  const [q, setQ] = useState('')
  const [activeId, setActiveId] = useState(last)
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? PROJECTS.filter((p) => `${p.name} ${p.subtitle} ${p.code} ${p.corridor} ${p.place}`.toLowerCase().includes(s)) : PROJECTS
  }, [q])
  const active = list.find((p) => p.id === activeId) || list[0]
  const open = (p) => { setStoredProjectId(p.id); navigate(`/workflow/${p.id}`) }

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {list.length ? (
        <ProjectsMap projects={list} activeId={active?.id} onHover={setActiveId} onSelect={open} />
      ) : (
        <div className="grid h-full place-items-center bg-indigo-50 text-[14px] text-slate-500">No corridors match “{q}”.</div>
      )}

      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute left-16 top-3 max-w-[min(480px,calc(100%-380px))] rounded-2xl border border-white/70 bg-white/92 px-4 py-2.5 shadow-lg backdrop-blur">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-500">Corridors</p>
          <h1 className="m-0 text-[20px] font-semibold tracking-tight text-indigo-950">Select a project</h1>
          <p className="m-0 truncate text-[13px] text-slate-500">{active ? `${active.name} · ${active.place}` : 'Choose a corridor on the map or from the list.'}</p>
        </div>

        <aside className="pointer-events-auto absolute bottom-4 right-4 top-3 flex w-[min(340px,38vw)] flex-col overflow-hidden rounded-3xl border border-white/70 bg-white/92 p-3 shadow-[0_20px_50px_rgba(30,27,75,0.16)] backdrop-blur">
          <label className="mb-2 flex h-10 shrink-0 items-center gap-2 rounded-xl border border-indigo-100 bg-white px-3 text-[13px] text-indigo-950 focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-50">
            <IconSearch className="h-4 w-4 text-indigo-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) open(list[0]) }}
              placeholder="Search corridors"
              className="min-w-0 flex-1 border-0 bg-transparent outline-none placeholder:text-slate-400"
            />
          </label>
          <div className="mb-2 flex shrink-0 items-center justify-between text-[12px] text-slate-400">
            <span>{list.length} on map</span>
            <span>Hover to locate</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            {list.map((p) => {
              const on = p.id === active?.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onMouseEnter={() => setActiveId(p.id)}
                  onClick={() => open(p)}
                  className={`flex min-h-0 flex-1 items-center gap-3 rounded-2xl border px-3 py-2 text-left transition ${on ? 'border-indigo-500 bg-indigo-50 shadow-[0_8px_20px_rgba(67,56,202,0.14)]' : 'border-indigo-100 bg-white hover:border-indigo-300'}`}
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${on ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-600'}`}><IconRoad /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-indigo-950">{p.name}</span>
                    <span className="block truncate text-[11px] text-slate-500">{p.place}</span>
                  </span>
                  <span className="shrink-0 text-[10px] font-bold tracking-wider text-indigo-400">{p.code}</span>
                </button>
              )
            })}
          </div>
        </aside>

        {active && (
          <div className="pointer-events-auto absolute bottom-4 left-4 flex max-w-[min(420px,calc(100%-380px))] items-center justify-between gap-3 rounded-2xl border border-white/70 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
            <div className="min-w-0">
              <p className="m-0 truncate text-[13px] font-semibold text-indigo-950">{active.name}</p>
              <p className="m-0 truncate text-[12px] text-slate-500">{active.place} · {active.km}</p>
            </div>
            <button type="button" onClick={() => open(active)} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-500">
              Open hub <IconArrow className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
