import { IconMore, IconPlus } from './Icons'

const T = {
  green: { border: 'border-green-400', glow: 'shadow-[0_14px_36px_rgba(34,197,94,0.18)]', plus: 'bg-green-500 text-white', icon: 'bg-green-50 text-green-600', pill: 'bg-green-50 text-green-700' },
  blue: { border: 'border-blue-400', glow: 'shadow-[0_14px_36px_rgba(59,130,246,0.18)]', plus: 'bg-blue-500 text-white', icon: 'bg-blue-50 text-blue-600', pill: 'bg-blue-50 text-blue-700' },
  indigo: { border: 'border-indigo-400', glow: 'shadow-[0_14px_36px_rgba(99,102,241,0.2)]', plus: 'bg-indigo-500 text-white', icon: 'bg-indigo-50 text-indigo-600', pill: 'bg-indigo-50 text-indigo-700' },
  violet: { border: 'border-violet-400', glow: 'shadow-[0_14px_36px_rgba(139,92,246,0.18)]', plus: 'bg-violet-500 text-white', icon: 'bg-violet-50 text-violet-600', pill: 'bg-violet-50 text-violet-700' },
  amber: { border: 'border-amber-400', glow: 'shadow-[0_14px_36px_rgba(245,158,11,0.18)]', plus: 'bg-amber-500 text-white', icon: 'bg-amber-50 text-amber-600', pill: 'bg-amber-50 text-amber-700' },
}

const cx = (...c) => c.filter(Boolean).join(' ')

const tilt = (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  e.currentTarget.style.setProperty('--mx', `${x * 100}%`)
  e.currentTarget.style.setProperty('--my', `${y * 100}%`)
  e.currentTarget.style.setProperty('--rx', `${(0.5 - y) * 8}deg`)
  e.currentTarget.style.setProperty('--ry', `${(x - 0.5) * 10}deg`)
}

const untilt = (e) => {
  e.currentTarget.style.setProperty('--rx', '0deg')
  e.currentTarget.style.setProperty('--ry', '0deg')
}

export default function NodeCard({ icon, title, subtitle, accent = 'indigo', selected, locked, size, delay, float, hint, className = '', onClick, onHover }) {
  const t = T[accent] || T.indigo
  const clickable = onClick && !locked
  const Tag = clickable ? 'button' : 'div'
  const pill = locked ? 'Locked' : selected ? 'Selected' : 'Ready'

  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={locked ? undefined : onClick}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={(e) => { if (float) untilt(e); onHover?.(false) }}
      onMouseMove={clickable && float ? tilt : undefined}
      style={delay != null ? { animationDelay: `${delay}ms` } : undefined}
      className={cx(
        'node-card group relative overflow-visible rounded-2xl border-2 bg-white text-left shadow-lg',
        className.includes('w-full') ? 'h-full w-full px-4 pb-3 pt-6' : size === 'origin' ? 'w-[230px] px-3 pb-2 pt-5' : size === 'sm' ? 'w-[196px] px-3 pb-2 pt-4' : 'w-[210px] px-4 pb-3 pt-6',
        t.border, t.glow, className,
        delay != null && 'rise',
        clickable && 'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500',
        clickable && float && 'is-hot',
        clickable && !float && 'transition hover:shadow-xl',
        locked && 'cursor-not-allowed opacity-55',
        selected && 'ring-2 ring-indigo-200',
      )}
    >
      <span className="node-spot pointer-events-none absolute inset-0 overflow-hidden rounded-[14px]" />
      <span className={cx('absolute left-1/2 top-0 grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-sm transition group-hover:scale-110 group-hover:rotate-90', t.plus)}>
        <IconPlus />
      </span>
      <span className="absolute left-0 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-950 ring-4 ring-white transition group-hover:scale-125" />
      <span className="absolute right-0 top-1/2 h-2.5 w-2.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-indigo-950 ring-4 ring-white transition group-hover:scale-125" />
      <div className="relative mb-2 flex items-start justify-between gap-3">
        <span className={cx('grid h-8 w-8 place-items-center rounded-full transition group-hover:scale-110', t.icon)}>{icon}</span>
        <IconMore className="mt-1 text-slate-400 transition group-hover:text-indigo-400" />
      </div>
      <h3 className="relative m-0 text-[14px] font-semibold tracking-tight text-indigo-950">{title}</h3>
      {subtitle && <p className="relative mt-1 mb-0 text-[13px] text-indigo-400">{subtitle}</p>}
      <div className="relative mt-2 flex items-center justify-between gap-2">
        <span className={cx('inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]', locked ? 'bg-slate-100 text-slate-500' : selected ? 'bg-indigo-50 text-indigo-700' : t.pill)}>
          {pill}
        </span>
        {clickable && (
          <span className="text-[11px] font-semibold text-indigo-500 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
            {hint || 'Open →'}
          </span>
        )}
      </div>
    </Tag>
  )
}
