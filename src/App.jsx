import { NavLink, Outlet, useLocation } from 'react-router-dom'

const tab = (on) => `relative rounded-lg px-3 py-2 text-sm font-medium no-underline transition ${on ? 'text-indigo-950 after:absolute after:inset-x-2 after:bottom-0 after:h-1 after:rounded-full after:bg-indigo-600' : 'text-slate-500 hover:bg-indigo-50 hover:text-indigo-800'}`

export default function App() {
  const { pathname } = useLocation()
  const onWorkflow = pathname === '/' || pathname.startsWith('/workflow')

  return (
    <div className="flex h-svh max-h-svh flex-col overflow-hidden bg-canvas text-ink">
      <header className="z-20 shrink-0 border-b border-indigo-100 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-[min(1280px,calc(100%-2rem))] items-center justify-between gap-4">
          <NavLink to="/" className="group flex items-center gap-2.5 text-indigo-950 no-underline">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-indigo-600 text-[11px] font-bold text-white shadow-sm transition group-hover:scale-105 group-hover:bg-indigo-500">NR</span>
            <span className="flex flex-col">
              <strong className="text-[13px] tracking-[0.08em] uppercase">NHIT RAMS</strong>
              <span className="text-[11px] font-normal text-slate-500">Road Asset Management · RoadVision workflow</span>
            </span>
          </NavLink>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-600 sm:inline-flex">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Live workflow
            </span>
            <nav className="flex items-end gap-1" aria-label="Temporary navigation">
              <NavLink to="/" className={() => tab(onWorkflow)}>Workflow</NavLink>
              <NavLink to="/ris/reported" className={({ isActive }) => tab(isActive)}>Reported</NavLink>
              <NavLink to="/ris/distress-prediction" className={({ isActive }) => tab(isActive)}>Predicted</NavLink>
            </nav>
          </div>
        </div>
      </header>
      <main className="dot-grid flex min-h-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
