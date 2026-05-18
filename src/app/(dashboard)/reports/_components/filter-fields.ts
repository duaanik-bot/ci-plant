import type { FilterField } from './FilterBar'

const DATE: FilterField[] = [
  { key: 'from', label: 'From', type: 'date' },
  { key: 'to', label: 'To', type: 'date' },
]

export const FILTER_FIELDS: Record<string, FilterField[]> = {
  ppv: [...DATE, { key: 'vendor', label: 'Vendor', type: 'text' }, { key: 'boardGrade', label: 'Board Grade', type: 'text' }],
  wastage: [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }, { key: 'stage', label: 'Stage #', type: 'text' }],
  oee: [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }, { key: 'operatorId', label: 'Operator ID', type: 'text' }],
  yield: [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }],
  otif: [...DATE, { key: 'customerId', label: 'Customer ID', type: 'text' }],
  'short-excess': [...DATE, { key: 'customerId', label: 'Customer ID', type: 'text' }],
  'downtime-pareto': [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }],
  'vendor-quality-ppm': [...DATE, { key: 'vendor', label: 'Vendor', type: 'text' }],
  'pm-compliance': [...DATE, { key: 'machineId', label: 'Machine ID', type: 'text' }],
}

export function filterFieldsFor(id: string): FilterField[] {
  return FILTER_FIELDS[id] ?? DATE
}
