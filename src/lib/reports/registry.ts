import type { ReportModule } from './types'

// Report modules are registered here as they are implemented.
export const REPORTS: Record<string, ReportModule<any>> = {}

export function getReport(id: string): ReportModule<any> | undefined {
  return REPORTS[id]
}

export function listReports() {
  return Object.values(REPORTS).map((m) => ({
    id: m.id, title: m.title, group: m.group, kpi: m.kpi,
  }))
}
