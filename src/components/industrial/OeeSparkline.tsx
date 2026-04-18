'use client'

/** Compact OEE trend (0–100 scale) for leaderboard rows. */
export function OeeSparkline({ values }: { values: number[] }) {
  if (!values.length) {
    return <span className="text-zinc-600 text-[10px]">—</span>
  }
  const min = 0
  const max = 100
  const w = 80
  const h = 22
  const pad = 2
  const pts = values
    .map((v, i) => {
      const x = pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad)
      const clamped = Math.min(max, Math.max(min, v))
      const y = h - pad - ((clamped - min) / (max - min)) * (h - 2 * pad)
      return `${x},${y}`
    })
    .join(' ')
  return (
    <svg width={w} height={h} className="inline-block align-middle" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline fill="none" stroke="rgb(251, 146, 60)" strokeWidth="1.5" points={pts} />
    </svg>
  )
}
