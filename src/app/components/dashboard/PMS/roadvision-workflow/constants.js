import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

const iri = (good, cap) => [
  { label: 'Good', range: `< ${good}`, hint: `IRI below ${good}` },
  { label: 'Fair', range: `${good}–${cap}`, hint: `IRI between ${good} and ${cap}` },
  { label: 'Poor', range: `> ${cap}`, hint: `IRI above ${cap}` },
]

const stub = (n, lat, lng, place) => ({
  id: `project-${n}`,
  name: `Project ${n}`,
  code: `P${n}`,
  corridor: 'Placeholder corridor',
  subtitle: 'Ready for domain selection',
  km: 'TBD',
  stage: 'Draft',
  lat,
  lng,
  place,
})

export const PROJECTS = [
  { id: 'adani-nanasa-nprpl', name: 'ADANI-NANASA (NPRPL)', code: 'NPRPL', corridor: 'Nanasa corridor', subtitle: 'Primary inventory corridor', km: '86.4 km', stage: 'Active', lat: 22.603, lng: 76.883, place: 'Nanasa, Madhya Pradesh' },
  stub(2, 22.72, 75.858, 'Indore, Madhya Pradesh'),
  stub(3, 23.26, 77.413, 'Bhopal, Madhya Pradesh'),
  stub(4, 23.182, 79.986, 'Jabalpur, Madhya Pradesh'),
  stub(5, 26.218, 78.183, 'Gwalior, Madhya Pradesh'),
  stub(6, 23.177, 75.789, 'Ujjain, Madhya Pradesh'),
  stub(7, 24.537, 81.304, 'Rewa, Madhya Pradesh'),
  stub(8, 23.839, 78.738, 'Sagar, Madhya Pradesh'),
]

export const PAVEMENT_TYPES = {
  bituminous: { id: 'bituminous', title: 'Bituminous', subtitle: 'Flexible pavement', shortLabel: 'Bituminous', iriRanges: iri(1800, 2400) },
  concrete: { id: 'concrete', title: 'Concrete', subtitle: 'Rigid pavement', shortLabel: 'Concrete', iriRanges: iri(2000, 2400) },
}

export const ROUTES = { reported: '/ris/reported', predicted: '/ris/distress-prediction' }

export const getProjectById = (id) => PROJECTS.find((p) => p.id === id) || null
export const getPavementType = (id) => PAVEMENT_TYPES[id] || null

const put = (key, value) => {
  try {
    value ? localStorage.setItem(key, value) : localStorage.removeItem(key)
  } catch {}
}

export const setStoredProjectId = (id) => put('rams_selected_project', id)
export const setStoredPavementType = (id) => put('rams_pavement_type', id)
export const getStoredProjectId = () => {
  try { return localStorage.getItem('rams_selected_project') } catch { return null }
}
export const getStoredPavementType = () => {
  try { return localStorage.getItem('rams_pavement_type') } catch { return null }
}

export function crumbs(project, extra = []) {
  return [
    { label: 'Projects', to: '/' },
    project && { label: project.name, to: `/workflow/${project.id}` },
    ...extra,
  ].filter(Boolean)
}

export function useWorkflow(needPavement = false) {
  const { projectId, pavementType } = useParams()
  const project = getProjectById(projectId)
  const pavement = getPavementType(pavementType)

  useEffect(() => {
    if (project) setStoredProjectId(project.id)
    if (pavement) setStoredPavementType(pavement.id)
  }, [project, pavement])

  if (!project) return { redirect: '/' }
  if (needPavement && !pavement) return { redirect: `/workflow/${projectId}/pms` }
  return { project, pavement, base: `/workflow/${project.id}` }
}
