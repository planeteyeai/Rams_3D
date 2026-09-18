import { Navigate, useNavigate } from 'react-router-dom'
import WorkflowShell from './WorkflowShell'
import NodeCard from './NodeCard'
import { SequenceLayout } from './ConnectorLayouts'
import { IconCondition, IconPredicted, IconReported } from './Icons'
import { ROUTES, crumbs, useWorkflow } from './constants'

export default function ProcessNodesPage() {
  const nav = useNavigate()
  const { redirect, project, pavement, base } = useWorkflow(true)
  if (redirect) return <Navigate to={redirect} replace />
  const q = `?project=${project.id}&pavement=${pavement.id}`
  const step = `${base}/pms/${pavement.id}`

  return (
    <WorkflowShell crumbs={[...crumbs(project), { label: 'PMS', to: `${base}/pms` }, { label: pavement.shortLabel }]} backTo={`${base}/pms`} backLabel="Back to PMS hub" eyebrow={`${pavement.title} process`} title="PMS process nodes" description="Condition feeds reported and predicted distress dashboards. Connectors show the working sequence.">
      <SequenceLayout nodes={[
        <NodeCard key="condition" icon={<IconCondition />} title="Condition" subtitle="IRI → Good / Fair / Poor" accent="green" hint="Open →" onClick={() => nav(`${step}/condition`)} />,
        <NodeCard key="reported" icon={<IconReported />} title="Reported Dashboard" subtitle="Observed distress" accent="blue" hint="Open →" onClick={() => nav(`${ROUTES.reported}${q}`)} />,
        <NodeCard key="predicted" icon={<IconPredicted />} title="Predicted Dashboard" subtitle="Modelled distress" accent="violet" hint="Open →" onClick={() => nav(`${ROUTES.predicted}${q}`)} />,
      ]} />
    </WorkflowShell>
  )
}
