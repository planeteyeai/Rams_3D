import { useEffect, useMemo } from 'react'
import { Navigate, useNavigate, useOutletContext } from 'react-router-dom'
import WorkflowShell from './WorkflowShell'
import NodeCard from './NodeCard'
import { GraphLayout } from './ConnectorLayouts'
import { IconBituminous, IconConcrete, IconInventory, IconPms, IconRoad, IconTraffic } from './Icons'
import { setStoredPavementType, useWorkflow } from './constants'
import NanasaRoad3DModal from './NanasaRoad3DModal'
import invData from '../../../../../assets/data/adani-inventory.json'
import pmsData from '../../../../../assets/data/adani-pms.json'

const NANASA_ID = 'adani-nanasa-nprpl'
const NANASA_NAME = 'ADANI-NANASA (NPRPL)'

function colorOf(asset) {
  return invData.types.find((t) => t.id === asset)?.color || '#64748b'
}

function NanasaDirect3D() {
  const nav = useNavigate()
  const { setHideHeader } = useOutletContext()
  useEffect(() => {
    setHideHeader(true)
    return () => setHideHeader(false)
  }, [setHideHeader])

  const date = invData.dates?.[0] || ''
  const inventoryPoints = useMemo(() => invData.points.filter((r) => {
    if (r.project !== NANASA_NAME) return false
    if (date && r.date !== date) return false
    return true
  }).map((r) => ({
    ...r,
    id: String(r.i),
    color: colorOf(r.asset),
    name: r.sub ? `${r.asset} (${r.sub})` : r.asset,
  })), [date])

  const inventoryLines = useMemo(() => invData.lines.filter((r) => !date || r.date === date).map((r) => ({
    ...r,
    id: String(r.i),
    color: colorOf(r.asset),
    name: r.sub ? `${r.asset} (${r.sub})` : r.asset,
  })), [date])

  const pavementRecords = useMemo(() => {
    const latest = pmsData.dates?.[0]
    return pmsData.records.filter((r) => {
      if (r.project !== NANASA_NAME) return false
      if (latest && r.date !== latest) return false
      return true
    })
  }, [])

  return (
    <div className="relative h-full min-h-0 w-full">
      <NanasaRoad3DModal
        open
        onClose={() => nav('/')}
        inventoryPoints={inventoryPoints}
        inventoryLines={inventoryLines}
        pavementRecords={pavementRecords}
        pavementDate={pmsData.dates?.[0] || ''}
      />
    </div>
  )
}

export default function DomainHubPage() {
  const nav = useNavigate()
  const { redirect, project, base } = useWorkflow()
  if (redirect) return <Navigate to={redirect} replace />
  if (project.id === NANASA_ID) return <NanasaDirect3D />
  const pick = (type) => { setStoredPavementType(type); nav(`${base}/pms/${type}`) }

  return (
    <WorkflowShell crumbs={[{ label: 'Projects', to: '/' }, { label: project.name }]} backTo="/" backLabel="Back to projects" eyebrow="Domain hub" title={project.name} description="Inventory and PMS branch from the project. Bituminous and Concrete connect from the PMS card.">
      <GraphLayout className="relative flex h-full min-h-0 items-center justify-center gap-10 overflow-hidden" links={[['project', 'inventory'], ['project', 'pms'], ['project', 'traffic'], ['pms', 'bituminous'], ['pms', 'concrete']]}>
        {(bind) => (
          <>
            <div ref={bind('project')} className="relative z-[1] w-fit self-center">
              <NodeCard icon={<IconRoad />} title={project.name} subtitle={project.corridor} selected size="origin" />
            </div>
            <div className="flex flex-col justify-center gap-5">
              <div ref={bind('inventory')} className="relative z-[1] w-fit">
                <NodeCard icon={<IconInventory />} title="Inventory" subtitle="Asset register and chainage" accent="blue" size="sm" hint="Open →" onClick={() => nav(`${base}/inventory`)} />
              </div>
              <div className="flex items-center gap-10">
                <div ref={bind('pms')} className="relative z-[1] w-fit">
                  <NodeCard icon={<IconPms />} title="PMS" subtitle="Pavement management system" accent="green" size="sm" hint="Open hub →" onClick={() => nav(`${base}/pms`)} />
                </div>
                <div className="flex flex-col gap-5">
                  <div ref={bind('bituminous')} className="relative z-[1] w-fit">
                    <NodeCard icon={<IconBituminous />} title="Bituminous" subtitle="Flexible pavement" accent="amber" size="sm" hint="Open →" onClick={() => pick('bituminous')} />
                  </div>
                  <div ref={bind('concrete')} className="relative z-[1] w-fit">
                    <NodeCard icon={<IconConcrete />} title="Concrete" subtitle="Rigid pavement" size="sm" hint="Open →" onClick={() => pick('concrete')} />
                  </div>
                </div>
              </div>
              <div ref={bind('traffic')} className="relative z-[1] w-fit">
                <NodeCard icon={<IconTraffic />} title="Traffic (AADT)" subtitle="AADT and PCU calculator" accent="violet" size="sm" hint="Open →" onClick={() => nav(`${base}/traffic`)} />
              </div>
            </div>
          </>
        )}
      </GraphLayout>
    </WorkflowShell>
  )
}
