/** > this idle gap on an in-progress stage triggers downtime lock (operator terminal). */
export const PRODUCTION_DOWNTIME_LOCK_SECONDS = 600

export const PRODUCTION_SHIFT_MINUTES_DEFAULT = 480

export const PRODUCTION_DOWNTIME_CATEGORIES = [
  { key: 'WAITING_TOOLING', label: 'Waiting for Tooling' },
  { key: 'WAITING_MATERIAL', label: 'Waiting for Material' },
  { key: 'MECHANICAL', label: 'Mechanical Issue' },
  { key: 'POWER_UTILITY', label: 'Power/Utility' },
  { key: 'CHANGEOVER_SETUP', label: 'Changeover/Setup' },
] as const

export type ProductionDowntimeCategoryKey = (typeof PRODUCTION_DOWNTIME_CATEGORIES)[number]['key']
