import { estimateProjectAadt } from './aadtFromSpeed'

const fmt = (n) => Math.round(n).toLocaleString('en-IN')

export default function RoadAadtBadge() {
  const result = estimateProjectAadt()
  const eachWay = result.increasing.hourly
  const title = [
    `Free-flow ${result.speedKmh} km/h, 2 lanes each way`,
    `${fmt(eachWay)} veh/h each direction`,
    `${fmt(result.hourly)} veh/h × 24 × 1.1`,
    'Live Google traffic speed is not connected, so this is the free-flow band, not a traffic count',
  ].join(' · ')

  return (
    <div className="text-right [text-shadow:0_2px_4px_rgba(0,0,0,0.95),0_0_10px_rgba(0,0,0,0.8)]" title={title}>
      <p className="m-0 text-[13px] font-bold uppercase tracking-[0.16em] text-violet-300">AADT</p>
      <p className="m-0 text-[36px] font-extrabold tabular-nums leading-none text-white">
        {fmt(result.aadt)}
        <span className="ml-2 text-[16px] font-semibold text-white">veh/day</span>
      </p>
    </div>
  )
}
