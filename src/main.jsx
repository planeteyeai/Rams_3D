import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ProjectCardsPage from './app/components/dashboard/PMS/roadvision-workflow/ProjectCardsPage.jsx'
import DomainHubPage from './app/components/dashboard/PMS/roadvision-workflow/DomainHubPage.jsx'
import InventoryHubPage from './app/components/dashboard/PMS/roadvision-workflow/InventoryHubPage.jsx'
import PmsHubPage from './app/components/dashboard/PMS/roadvision-workflow/PmsHubPage.jsx'
import ProcessNodesPage from './app/components/dashboard/PMS/roadvision-workflow/ProcessNodesPage.jsx'
import ConditionPlaceholderPage from './app/components/dashboard/PMS/roadvision-workflow/ConditionPlaceholderPage.jsx'
import TrafficAadtPage from './app/components/dashboard/PMS/roadvision-workflow/TrafficAadtPage.jsx'
import DashboardPlaceholder from './app/components/dashboard/RIS/DashboardPlaceholder.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<ProjectCardsPage />} />
          <Route path="workflow/:projectId" element={<DomainHubPage />} />
          <Route path="workflow/:projectId/inventory" element={<InventoryHubPage />} />
          <Route path="workflow/:projectId/pms" element={<PmsHubPage />} />
          <Route path="workflow/:projectId/traffic" element={<TrafficAadtPage />} />
          <Route
            path="workflow/:projectId/pms/:pavementType"
            element={<ProcessNodesPage />}
          />
          <Route
            path="workflow/:projectId/pms/:pavementType/condition"
            element={<ConditionPlaceholderPage />}
          />
          <Route
            path="ris/reported"
            element={<DashboardPlaceholder kind="reported" />}
          />
          <Route
            path="ris/distress-prediction"
            element={<DashboardPlaceholder kind="predicted" />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
