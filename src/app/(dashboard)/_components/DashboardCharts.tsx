'use client'

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts'

type TrendRow = { day: string; ci01: number; ci02: number; ci03: number }
type WastageRow = { machine: string; pct: number }

export function ImpressionsTrendChart({ data }: { data: TrendRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data}>
        <XAxis dataKey="day" stroke="#94a3b8" fontSize={12} />
        <YAxis stroke="#94a3b8" fontSize={12} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
          labelStyle={{ color: '#e2e8f0' }}
        />
        <Legend />
        <Line type="monotone" dataKey="ci01" name="PRN-01" stroke="#3B82F6" strokeWidth={2} dot={{ fill: '#3B82F6' }} />
        <Line type="monotone" dataKey="ci02" name="PRN-02" stroke="#14B8A6" strokeWidth={2} dot={{ fill: '#14B8A6' }} />
        <Line type="monotone" dataKey="ci03" name="PRN-03" stroke="#F97316" strokeWidth={2} dot={{ fill: '#F97316' }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function WastageBarChart({ data }: { data: WastageRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <XAxis dataKey="machine" stroke="#94a3b8" fontSize={12} />
        <YAxis stroke="#94a3b8" fontSize={12} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
          labelStyle={{ color: '#e2e8f0' }}
        />
        <ReferenceLine y={5} stroke="#EF4444" strokeDasharray="3 3" />
        <Bar dataKey="pct" name="Wastage %" radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.pct <= 3 ? '#22C55E' : entry.pct <= 5 ? '#F59E0B' : '#EF4444'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
