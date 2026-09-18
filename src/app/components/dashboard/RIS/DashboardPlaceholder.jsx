import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ProjectsMap from '../PMS/roadvision-workflow/ProjectsMap'
import { IconArrow, IconBack } from '../PMS/roadvision-workflow/Icons'
import {
  getPavementType,
  getProjectById,
  getStoredPavementType,
  getStoredProjectId,
} from '../PMS/roadvision-workflow/constants'

const TONE = { Good: 'pin-green', Fair: 'pin-amber', Poor: 'pin-rose', High: 'pin-rose', Med: 'pin-amber', Low: 'pin-green' }

const samples = (p, reported) => (reported
  ? [['R1', 'Good'], ['R2', 'Fair'], ['R3', 'Poor'], ['R4', 'Fair'], ['R5', 'Good']]
  : [['P1', 'Low'], ['P2', 'Med'], ['P3', 'High'], ['P4', 'Med'], ['P5', 'Low']]
).map(([code, status], i) => ({
  id: `${reported ? 'rep' : 'pred'}-${i}`,
  code,
  name: `${reported ? 'Observed' : 'Predicted'} ${status}`,
  place: `Ch ${(95 + i * 9).toFixed(0)}+000`,
  status,
  tone: TONE[status],
  lat: p.lat + (i - 2) * 0.038,
  lng: p.lng + (i % 2 ? 0.048 : -0.042),
}))

export default function DashboardPlaceholder({ kind }) {
  const [params] = useSearchParams()
  const project = getProjectById(params.get('project')) || getProjectById(getStoredProjectId())
  const pavement = getPavementType(params.get('pavement')) || getPavementType(getStoredPavementType())
  const reported = kind === 'reported'
  const backTo = project && pavement ? `/workflow/${project.id}/pms/${pavement.id}` : '/'
  const points = useMemo(() => (project ? [project, ...samples(project, reported)] : []), [project, reported])
  const [activeId, setActiveId] = useState(points[1]?.id || project?.id)
  const active = points.find((p) => p.id === activeId) || points[0]
  const list = points.filter((p) => p.id !== project?.id)

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {points.length ? (
        <ProjectsMap
          projects={points}
          activeId={active?.id}
          onHover={setActiveId}
          onSelect={(p) => setActiveId(p.id)}
          maxZoom={12}
          pad={[[20, 88], [360, 88]]}
        />
      ) : (
        <div className="grid h-full place-items-center text-[14px] text-slate-500">Open a project from the workflow to view this map.</div>
      )}

      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute left-16 top-3 flex max-w-[min(520px,calc(100%-380px))] items-start gap-2">
          <Link to={backTo} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/70 bg-white/92 px-3 text-[13px] text-indigo-950 no-underline shadow-lg backdrop-blur hover:border-indigo-300">
            <IconBack className="h-4 w-4" /> Back
          </Link>
          <div className="min-w-0 rounded-2xl border border-white/70 bg-white/92 px-4 py-2.5 shadow-lg backdrop-blur">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-500">{reported ? 'Reported' : 'Predicted'}</p>
            <h1 className="m-0 text-[20px] font-semibold tracking-tight text-indigo-950">{reported ? 'Reported Dashboard' : 'Predicted Dashboard'}</h1>
            <p className="m-0 truncate text-[13px] text-slate-500">{project?.name || 'No project'} · {pavement ? `${pavement.title} · ${pavement.subtitle}` : 'No pavement'}</p>
          </div>
        </div>

        <aside className="pointer-events-auto absolute bottom-4 right-4 top-3 flex w-[min(340px,38vw)] flex-col overflow-hidden rounded-3xl border border-white/70 bg-white/92 p-3 shadow-[0_20px_50px_rgba(30,27,75,0.16)] backdrop-blur">
          <div className="mb-2 flex shrink-0 items-center justify-between text-[12px] text-slate-400">
            <span>{list.length} {reported ? 'observed' : 'modelled'} points</span>
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
                  onClick={() => setActiveId(p.id)}
                  className={`flex min-h-0 flex-1 items-center gap-3 rounded-2xl border px-3 py-2 text-left transition ${on ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-100 bg-white hover:border-indigo-300'}`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${p.tone === 'pin-rose' ? 'bg-rose-500' : p.tone === 'pin-amber' ? 'bg-amber-500' : p.tone === 'pin-green' ? 'bg-green-600' : 'bg-violet-600'}`}>{p.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-indigo-950">{p.name}</span>
                    <span className="block truncate text-[11px] text-slate-500">{p.place}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        {active && (
          <div className="pointer-events-auto absolute bottom-4 left-4 flex max-w-[min(420px,calc(100%-380px))] items-center justify-between gap-3 rounded-2xl border border-white/70 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
            <div className="min-w-0">
              <p className="m-0 truncate text-[13px] font-semibold text-indigo-950">{active.name}</p>
              <p className="m-0 truncate text-[12px] text-slate-500">{active.place}{active.status ? ` · ${active.status}` : ''}</p>
            </div>
            <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-indigo-500">
              On corridor <IconArrow className="h-3.5 w-3.5" />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
