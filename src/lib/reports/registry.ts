import type { ReportModule } from './types'
import * as ppv from './modules/ppv'
import * as wastage from './modules/wastage'
import * as oee from './modules/oee'
import * as yieldRpt from './modules/yield'
import * as otif from './modules/otif'
import * as shortExcess from './modules/short-excess'
import * as downtimePareto from './modules/downtime-pareto'
import * as vendorPpm from './modules/vendor-quality-ppm'
import * as pmCompliance from './modules/pm-compliance'

// Report modules are registered here as they are implemented.
export const REPORTS: Record<string, ReportModule<any>> = {
  ppv: { ...ppv.meta, filterSchema: ppv.filterSchema, query: ppv.query },
  wastage: { ...wastage.meta, filterSchema: wastage.filterSchema, query: wastage.query },
  oee: { ...oee.meta, filterSchema: oee.filterSchema, query: oee.query },
  yield: { ...yieldRpt.meta, filterSchema: yieldRpt.filterSchema, query: yieldRpt.query },
  otif: { ...otif.meta, filterSchema: otif.filterSchema, query: otif.query },
  'short-excess': { ...shortExcess.meta, filterSchema: shortExcess.filterSchema, query: shortExcess.query },
  'downtime-pareto': { ...downtimePareto.meta, filterSchema: downtimePareto.filterSchema, query: downtimePareto.query },
  'vendor-quality-ppm': { ...vendorPpm.meta, filterSchema: vendorPpm.filterSchema, query: vendorPpm.query },
  'pm-compliance': { ...pmCompliance.meta, filterSchema: pmCompliance.filterSchema, query: pmCompliance.query },
}

export function getReport(id: string): ReportModule<any> | undefined {
  return REPORTS[id]
}

export function listReports() {
  return Object.values(REPORTS).map((m) => ({
    id: m.id, title: m.title, group: m.group, kpi: m.kpi,
  }))
}
