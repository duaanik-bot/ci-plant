'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type TrendPoint = {
  monthKey: string
  avgRate: number
  high: number
  low: number
  lastPaid: number
}

type TrendTooltip = { high: number | null; low: number | null; lastPaid: number | null }

export function PriceTrendSparkline({
  data,
  tooltip,
}: {
  data: TrendPoint[]
  tooltip: TrendTooltip
}) {
  if (!data.length) {
    return <span className="text-xs text-neutral-600 tabular-nums">No 6m trend</span>
  }
  const chartData = data.map((d) => ({ ...d, shortMonth: d.monthKey.slice(5) }))
  return (
    <div className="w-[128px] h-10 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
          <Tooltip
            cursor={{ stroke: '#f59e0b', strokeOpacity: 0.35 }}
            content={() => (
              <div className="rounded bg-background px-2 py-1.5 text-xs text-ds-ink shadow-xl space-y-0.5">
                <div className="font-mono tabular-nums">
                  High:{' '}
                  {tooltip.high != null ? `₹${tooltip.high.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </div>
                <div className="font-mono tabular-nums">
                  Low:{' '}
                  {tooltip.low != null ? `₹${tooltip.low.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </div>
                <div className="font-mono tabular-nums">
                  Last paid:{' '}
                  {tooltip.lastPaid != null
                    ? `₹${tooltip.lastPaid.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '—'}
                </div>
              </div>
            )}
          />
          <Line
            type="monotone"
            dataKey="avgRate"
            stroke="#f59e0b"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

type DeliveryAccuracyPoint = { label: string; accuracyPct: number; orders?: number }

export function DeliveryAccuracyChart({ data }: { data: DeliveryAccuracyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
        <XAxis
          dataKey="label"
          tick={{ fill: '#a1a1aa', fontSize: 9 }}
          interval={0}
          angle={-12}
          textAnchor="end"
          height={36}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: '#a1a1aa', fontSize: 9 }}
          width={28}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#09090b',
            border: `1px solid rgba(245, 158, 11, 0.35)`,
            borderRadius: 8,
            fontSize: 11,
          }}
          labelStyle={{ color: '#e4e4e7' }}
          formatter={(value: number, _n, item) => [
            `${value}% (${(item?.payload as { orders?: number })?.orders ?? 0} dispatches)`,
            'OTIF accuracy',
          ]}
        />
        <Bar
          dataKey="accuracyPct"
          name="Delivery accuracy"
          fill="#f59e0b"
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
