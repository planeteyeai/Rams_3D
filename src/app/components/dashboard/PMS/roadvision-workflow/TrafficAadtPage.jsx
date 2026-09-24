import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import WorkflowShell from './WorkflowShell'
import { crumbs, useWorkflow } from './constants'

// IRC:64-1990 PCU equivalents (rural roads) — editable per project
const DEFAULT_CLASSES = [
  { id: 'car', label: 'Car / Jeep / Van', pcu: 1.0 },
  { id: 'two', label: 'Two-wheeler', pcu: 0.5 },
  { id: 'auto', label: 'Auto-rickshaw', pcu: 1.0 },
  { id: 'lcv', label: 'LCV', pcu: 1.5 },
  { id: 'bus', label: 'Bus', pcu: 3.0 },
  { id: 'truck2', label: 'Truck (2-axle)', pcu: 3.0 },
  { id: 'mav', label: 'Multi-axle truck (MAV)', pcu: 4.5 },
  { id: 'tractor', label: 'Tractor-trailer', pcu: 4.5 },
  { id: 'cycle', label: 'Cycle', pcu: 0.5 },
]

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const fmt = (n, d = 0) =>
  Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'

const inputCls =
  'h-9 w-full rounded-lg border border-indigo-100 bg-white px-2.5 text-[13px] text-indigo-950 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
const labelCls = 'mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-indigo-400'

function Result({ label, value, unit, formula, tone = 'indigo' }) {
  const tones = {
    indigo: 'border-indigo-200 bg-indigo-50/60 text-indigo-700',
    green: 'border-green-200 bg-green-50/60 text-green-700',
    amber: 'border-amber-200 bg-amber-50/60 text-amber-700',
  }
  return (
    <div className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <p className="m-0 text-[11px] font-bold uppercase tracking-[0.1em]">{label}</p>
      <p className="m-0 mt-1 text-[24px] font-semibold tabular-nums text-indigo-950">
        {value}
        {unit && <span className="ml-1 text-[13px] font-medium text-slate-500">{unit}</span>}
      </p>
      {formula && <p className="m-0 mt-0.5 text-[11px] text-slate-500">{formula}</p>}
    </div>
  )
}

export default function TrafficAadtPage() {
  const { redirect, project, base } = useWorkflow()

  // Method 1: continuous count over a year
  const [yearTotal, setYearTotal] = useState('')
  const [yearDays, setYearDays] = useState(365)

  // Method 2: classified short count → ADT → AADT → PCU
  const [countDays, setCountDays] = useState(7)
  const [seasonalFactor, setSeasonalFactor] = useState(1)
  const [dayFactor, setDayFactor] = useState(1)
  const [classes, setClasses] = useState(() => DEFAULT_CLASSES.map((c) => ({ ...c, count: '' })))

  const annual = useMemo(() => {
    const total = num(yearTotal)
    const days = num(yearDays)
    return days > 0 && total > 0 ? total / days : null
  }, [yearTotal, yearDays])

  const short = useMemo(() => {
    const days = num(countDays)
    const expansion = num(seasonalFactor) * num(dayFactor)
    const rows = classes.map((c) => {
      const adt = days > 0 ? num(c.count) / days : 0
      const aadt = adt * expansion
      return { ...c, adt, aadt, aadtPcu: aadt * num(c.pcu) }
    })
    const totalCount = classes.reduce((s, c) => s + num(c.count), 0)
    const adt = rows.reduce((s, r) => s + r.adt, 0)
    const aadt = rows.reduce((s, r) => s + r.aadt, 0)
    const aadtPcu = rows.reduce((s, r) => s + r.aadtPcu, 0)
    return { rows, totalCount, adt, aadt, aadtPcu, expansion, valid: days > 0 && totalCount > 0 }
  }, [classes, countDays, seasonalFactor, dayFactor])

  if (redirect) return <Navigate to={redirect} replace />

  const setClass = (id, key, value) =>
    setClasses((list) => list.map((c) => (c.id === id ? { ...c, [key]: value } : c)))
  const addClass = () =>
    setClasses((list) => [...list, { id: `custom-${Date.now()}`, label: 'Other', pcu: 1, count: '', custom: true }])
  const removeClass = (id) => setClasses((list) => list.filter((c) => c.id !== id))
  const resetShort = () => {
    setClasses(DEFAULT_CLASSES.map((c) => ({ ...c, count: '' })))
    setCountDays(7)
    setSeasonalFactor(1)
    setDayFactor(1)
  }

  return (
    <WorkflowShell
      crumbs={[...crumbs(project), { label: 'Traffic (AADT)' }]}
      backTo={base}
      backLabel="Back to domain hub"
      eyebrow="Traffic"
      title="AADT calculator"
      description="Annual Average Daily Traffic from a yearly total, or from a classified short count with seasonal expansion and PCU conversion."
    >
      <div className="grid h-full min-h-0 gap-3 overflow-y-auto pb-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* Method 1 */}
        <section className="flex flex-col gap-3 rounded-3xl border border-indigo-100 bg-white p-4 shadow-xl">
          <div>
            <p className="m-0 text-[11px] font-bold uppercase tracking-[0.12em] text-indigo-500">Method 1</p>
            <h2 className="m-0 text-[16px] font-semibold text-indigo-950">From annual total</h2>
            <p className="m-0 mt-0.5 text-[12px] text-slate-500">AADT = Total vehicles counted in a year ÷ days in year</p>
          </div>
          <label>
            <span className={labelCls}>Total vehicles in year</span>
            <input type="number" min="0" className={inputCls} value={yearTotal} onChange={(e) => setYearTotal(e.target.value)} placeholder="e.g. 5475000" />
          </label>
          <label>
            <span className={labelCls}>Days in year</span>
            <select className={inputCls} value={yearDays} onChange={(e) => setYearDays(Number(e.target.value))}>
              <option value={365}>365</option>
              <option value={366}>366 (leap year)</option>
            </select>
          </label>
          <Result
            label="AADT"
            value={annual == null ? '—' : fmt(annual)}
            unit="veh/day"
            formula={annual == null ? 'Enter the yearly total' : `${fmt(num(yearTotal))} ÷ ${yearDays}`}
          />
        </section>

        {/* Method 2 */}
        <section className="flex min-h-0 flex-col gap-3 rounded-3xl border border-indigo-100 bg-white p-4 shadow-xl">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="m-0 text-[11px] font-bold uppercase tracking-[0.12em] text-indigo-500">Method 2</p>
              <h2 className="m-0 text-[16px] font-semibold text-indigo-950">From classified short count</h2>
              <p className="m-0 mt-0.5 text-[12px] text-slate-500">
                ADT = count ÷ count days · AADT = ADT × seasonal × day-of-week factor · AADT<sub>PCU</sub> = Σ (AADT<sub>i</sub> × PCU<sub>i</sub>)
              </p>
            </div>
            <button type="button" onClick={resetShort} className="rounded-full border border-indigo-100 px-3 py-1 text-[12px] font-semibold text-indigo-600 hover:bg-indigo-50">
              Reset
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className={labelCls}>Count duration (days)</span>
              <input type="number" min="1" className={inputCls} value={countDays} onChange={(e) => setCountDays(e.target.value)} />
            </label>
            <label>
              <span className={labelCls}>Seasonal factor</span>
              <input type="number" min="0" step="0.01" className={inputCls} value={seasonalFactor} onChange={(e) => setSeasonalFactor(e.target.value)} />
            </label>
            <label>
              <span className={labelCls}>Day-of-week factor</span>
              <input type="number" min="0" step="0.01" className={inputCls} value={dayFactor} onChange={(e) => setDayFactor(e.target.value)} />
            </label>
          </div>

          <div className="min-h-0 overflow-auto rounded-2xl border border-indigo-100">
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 bg-indigo-50 text-left text-[11px] uppercase tracking-[0.06em] text-indigo-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Vehicle class</th>
                  <th className="px-3 py-2 font-semibold">Count</th>
                  <th className="px-3 py-2 font-semibold">PCU factor</th>
                  <th className="px-3 py-2 text-right font-semibold">ADT</th>
                  <th className="px-3 py-2 text-right font-semibold">AADT</th>
                  <th className="px-3 py-2 text-right font-semibold">AADT PCU</th>
                  <th className="w-8 px-1 py-2" />
                </tr>
              </thead>
              <tbody>
                {short.rows.map((r) => (
                  <tr key={r.id} className="border-t border-indigo-50">
                    <td className="px-3 py-1.5">
                      {r.custom ? (
                        <input className={inputCls} value={r.label} onChange={(e) => setClass(r.id, 'label', e.target.value)} />
                      ) : (
                        <span className="font-medium text-indigo-950">{r.label}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <input type="number" min="0" className={`${inputCls} w-28`} value={r.count} onChange={(e) => setClass(r.id, 'count', e.target.value)} placeholder="0" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input type="number" min="0" step="0.1" className={`${inputCls} w-20`} value={r.pcu} onChange={(e) => setClass(r.id, 'pcu', e.target.value)} />
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{fmt(r.adt, 1)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{fmt(r.aadt, 1)}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-indigo-950">{fmt(r.aadtPcu, 1)}</td>
                    <td className="px-1 py-1.5 text-center">
                      {r.custom && (
                        <button type="button" onClick={() => removeClass(r.id)} title="Remove class" className="rounded-md px-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={addClass} className="self-start rounded-full border border-dashed border-indigo-300 px-3 py-1 text-[12px] font-semibold text-indigo-600 hover:bg-indigo-50">
            + Add vehicle class
          </button>

          <div className="grid gap-3 sm:grid-cols-3">
            <Result label="ADT" value={short.valid ? fmt(short.adt) : '—'} unit="veh/day" formula={`${fmt(short.totalCount)} vehicles ÷ ${fmt(num(countDays))} days`} />
            <Result tone="amber" label="AADT" value={short.valid ? fmt(short.aadt) : '—'} unit="veh/day" formula={`ADT × ${fmt(short.expansion, 2)} expansion`} />
            <Result tone="green" label="AADT (PCU)" value={short.valid ? fmt(short.aadtPcu) : '—'} unit="PCU/day" formula="Σ class AADT × PCU factor" />
          </div>
          <p className="m-0 text-[11px] text-slate-400">
            Default PCU factors follow IRC:64-1990 for rural roads; adjust them to your project&apos;s standard.
          </p>
        </section>
      </div>
    </WorkflowShell>
  )
}
