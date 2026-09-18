import { Navigate } from 'react-router-dom'
import WorkflowShell from './WorkflowShell'
import { crumbs, useWorkflow } from './constants'

export default function InventoryPlaceholderPage() {
  const { redirect, project, base } = useWorkflow()
  if (redirect) return <Navigate to={redirect} replace />

  return (
    <WorkflowShell crumbs={[...crumbs(project), { label: 'Inventory' }]} backTo={base} backLabel="Back to domain hub" eyebrow="Inventory" title="Inventory workspace" description="Placeholder for the inventory node. Road register and chainage views will plug in here without changing this workflow shell.">
      <div className="h-full rounded-3xl border border-indigo-100 bg-white p-5 text-slate-500 shadow-xl">
        <p className="mb-2.5">Selected project: <strong className="text-indigo-950">{project.name}</strong></p>
        <p className="m-0">Inventory cards and maps are not part of this first frontend slice.</p>
      </div>
    </WorkflowShell>
  )
}
