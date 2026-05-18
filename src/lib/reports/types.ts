import type { z } from 'zod'

export type ColumnType = 'text' | 'num' | 'inr' | 'pct' | 'date'

export interface ColumnDef {
  key: string
  label: string
  type: ColumnType
  align?: 'left' | 'right'
  total?: boolean
}

export interface SummaryCard {
  label: string
  value: string
  tone?: 'good' | 'bad' | 'neutral'
}

export interface ChartSpec {
  kind: 'bar' | 'line' | 'stacked' | 'pareto'
  x: string
  series: string[]
  data: Record<string, unknown>[]
}

export interface ReportView {
  id: string
  label: string
}

export interface ReportResult {
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
  summary: SummaryCard[]
  chart?: ChartSpec
  views?: ReportView[]
  meta: { generatedAt: string; filtersApplied: Record<string, string> }
}

export type ReportGroup =
  | 'production' | 'quality' | 'delivery' | 'material' | 'procurement' | 'maintenance'

export interface ReportModule<F = Record<string, unknown>> {
  id: string
  title: string
  group: ReportGroup
  kpi: string
  filterSchema: z.ZodType<F>
  query: (filters: F) => Promise<ReportResult>
}
