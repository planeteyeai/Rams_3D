import { Navigate, useNavigate } from 'react-router-dom'
import WorkflowShell from './WorkflowShell'
import NodeCard from './NodeCard'
import { GraphLayout } from './ConnectorLayouts'
import { IconBituminous, IconConcrete, IconInventory, IconPms, IconRoad } from './Icons'
import { setStoredPavementType, useWorkflow } from './constants'

export default function DomainHubPage() {
  const nav = useNavigate()
  const { redirect, project, base } = useWorkflow()
  if (redirect) return <Navigate to={redirect} replace />
  const pick = (type) => { setStoredPavementType(type); nav(`${base}/pms/${type}`) }

  return (
    <WorkflowShell crumbs={[{ label: 'Projects', to: '/' }, { label: project.name }]} backTo="/" backLabel="Back to projects" eyebrow="Domain hub" title={project.name} description="Inventory and PMS branch from the project. Bituminous and Concrete connect from the PMS card.">
      <GraphLayout className="relative flex h-full min-h-0 items-center justify-center gap-10 overflow-hidden" links={[['project', 'inventory'], ['project', 'pms'], ['pms', 'bituminous'], ['pms', 'concrete']]}>
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
            </div>
          </>
        )}
      </GraphLayout>
    </WorkflowShell>
  )
}
