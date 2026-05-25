'use client'
import type { ChartSpec } from '@/lib/reports/types'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts'

const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed']

export function ReportChart({ chart }: { chart?: ChartSpec }) {
  if (!chart) return null
  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey={chart.x} fontSize={11} />
      <YAxis fontSize={11} />
      <Tooltip />
      <Legend />
    </>
  )
  return (
    <div className="h-72 w-full rounded-lg bg-[var(--bg-card)] p-3 shadow-ds-depth-sm">
      <ResponsiveContainer>
        {chart.kind === 'line' ? (
          <LineChart data={chart.data}>
            {common}
            {chart.series.map((k, i) => (
              <Line key={k} dataKey={k} stroke={COLORS[i % COLORS.length]} dot={false} />
            ))}
          </LineChart>
        ) : chart.kind === 'pareto' ? (
          <ComposedChart data={chart.data}>
            {common}
            <Bar dataKey={chart.series[0]} fill={COLORS[0]} />
            {chart.series[1] && (
              <Line dataKey={chart.series[1]} stroke={COLORS[2]} dot={false} />
            )}
          </ComposedChart>
        ) : (
          <BarChart data={chart.data}>
            {common}
            {chart.series.map((k, i) => (
              <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]}
                   stackId={chart.kind === 'stacked' ? 'a' : undefined} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
