import type { ReportModule } from './types'
import * as ppv from './modules/ppv'
import * as wastage from './modules/wastage'

// Report modules are registered here as they are implemented.
export const REPORTS: Record<string, ReportModule<any>> = {
  ppv: { ...ppv.meta, filterSchema: ppv.filterSchema, query: ppv.query },
  wastage: { ...wastage.meta, filterSchema: wastage.filterSchema, query: wastage.query },
}

export function getReport(id: string): ReportModule<any> | undefined {
  return REPORTS[id]
}

export function listReports() {
  return Object.values(REPORTS).map((m) => ({
    id: m.id, title: m.title, group: m.group, kpi: m.kpi,
  }))
}
