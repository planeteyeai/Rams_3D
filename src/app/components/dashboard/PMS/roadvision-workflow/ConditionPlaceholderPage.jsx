import { Navigate } from 'react-router-dom'
import WorkflowShell from './WorkflowShell'
import { crumbs, useWorkflow } from './constants'

const IRI = {
  good: 'border-green-400 text-green-600',
  fair: 'border-amber-400 text-amber-600',
  poor: 'border-rose-400 text-rose-600',
}

export default function ConditionPlaceholderPage() {
  const { redirect, project, pavement, base } = useWorkflow(true)
  if (redirect) return <Navigate to={redirect} replace />
  const step = `${base}/pms/${pavement.id}`

  return (
    <WorkflowShell crumbs={[...crumbs(project), { label: 'PMS', to: `${base}/pms` }, { label: pavement.shortLabel, to: step }, { label: 'Condition' }]} backTo={step} backLabel="Back to process nodes" eyebrow="Condition node" title={`${pavement.title} IRI ranges`} description="Display-only thresholds for this first slice. Survey mapping to Good / Fair / Poor will come next.">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-3xl border border-indigo-100 bg-white p-5 shadow-xl">
        <div className="mb-4 grid shrink-0 gap-3 md:grid-cols-2">
          {[['Project', project.name], ['Pavement', `${pavement.title} · ${pavement.subtitle}`]].map(([k, v]) => (
            <div key={k}><span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-indigo-400">{k}</span><strong className="text-[15px] text-indigo-950">{v}</strong></div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-3">
          {pavement.iriRanges.map((item) => (
            <article key={item.label} className={`rounded-2xl border-2 bg-white p-4 transition hover:-translate-y-1 hover:shadow-lg ${IRI[item.label.toLowerCase()]}`}>
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.1em]">{item.label}</p>
              <p className="mb-1.5 text-[22px] font-semibold text-indigo-950">{item.range}</p>
              <p className="m-0 text-[13px] text-slate-500">{item.hint}</p>
            </article>
          ))}
        </div>
      </div>
    </WorkflowShell>
  )
}
