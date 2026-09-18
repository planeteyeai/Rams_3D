import { Link } from 'react-router-dom'
import { IconBack, IconChevron } from './Icons'

const backCls = 'inline-flex min-h-8 items-center gap-1.5 rounded-full border border-indigo-100 bg-white px-3 py-1.5 text-[13px] text-indigo-950 no-underline shadow-sm transition hover:-translate-x-0.5 hover:border-indigo-300 hover:shadow-md'

export default function WorkflowShell({ crumbs, backTo, backLabel = 'Back', eyebrow, title, description, action, children }) {
  return (
    <section className="mx-auto flex h-full w-[min(1280px,calc(100%-2rem))] flex-col overflow-hidden py-3 text-left">
      {backTo ? (
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <Link to={backTo} className={backCls}><IconBack className="h-4 w-4" /><span>{backLabel}</span></Link>
          <nav className="flex flex-wrap items-center gap-0.5 text-[13px] text-indigo-400" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="inline-flex items-center gap-0.5">
                {i > 0 && <IconChevron className="h-3.5 w-3.5 opacity-50" />}
                {i === crumbs.length - 1 || !c.to
                  ? <span className={i === crumbs.length - 1 ? 'font-semibold text-indigo-950' : ''}>{c.label}</span>
                  : <Link to={c.to} className="rounded-md px-1 text-indigo-400 no-underline transition hover:bg-indigo-50 hover:text-indigo-700">{c.label}</Link>}
              </span>
            ))}
          </nav>
        </div>
      ) : null}
      <header className="mb-3 flex shrink-0 items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-500">{eyebrow}</p>}
          <h1 className="m-0 mb-0.5 text-[22px] font-semibold tracking-tight text-indigo-950">{title}</h1>
          {description && <p className="m-0 max-w-3xl truncate text-[13px] leading-5 text-slate-500">{description}</p>}
        </div>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  )
}
