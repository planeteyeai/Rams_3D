import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

export default function App() {
  const [hideHeader, setHideHeader] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')

  return (
    <div className="flex h-svh max-h-svh flex-col overflow-hidden bg-[#f1f3f6] text-[#0b1424]">
      {!hideHeader && (
        <header className="z-30 shrink-0 border-b border-[#e2e8f0] bg-white">
          <div className="flex h-12 w-full items-center gap-4 px-4 lg:px-5">
            <NavLink to="/" className="group flex min-w-0 shrink-0 items-center gap-2.5 text-[#0b1424] no-underline">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-[#0b1424] text-[10px] font-bold tracking-[0.08em] text-white">
                NR
              </span>
              <strong className="text-[16px] font-semibold tracking-[0.04em]">RAMS²</strong>
            </NavLink>
          </div>
        </header>
      )}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#f1f3f6]">
        <Outlet context={{ setHideHeader, projectQuery, setProjectQuery }} />
      </main>
    </div>
  )
}
