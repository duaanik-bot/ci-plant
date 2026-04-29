'use client'

import type { KitSegmentState, ProductionKitForLine } from '@/lib/production-kit-status'

const techMono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums text-xs sm:text-xs'

function mergeSegments(lines: ProductionKitForLine[]): KitSegmentState[] {
  const keys: Array<'die' | 'block' | 'shade'> = ['die', 'block', 'shade']
  return keys.map((key) => {
    const parts = lines
      .map((l) => l.segments.find((s) => s.key === key))
      .filter((s): s is KitSegmentState => s != null)
    const ok = parts.length === 0 ? true : parts.every((p) => p.ok)
    const missing = parts.some((p) => p.missing)
    const failing = parts.find((p) => !p.ok)
    const label = key === 'die' ? 'DIE' : key === 'block' ? 'BLOCK' : 'SHADE'
    return {
      key,
      label,
      ok,
      missing,
      detail: failing?.detail ?? (parts[0]?.detail ?? ''),
      technicalId: failing?.technicalId ?? parts.find((p) => p.technicalId)?.technicalId ?? null,
    }
  })
}

export function ProductionReadinessBar({
  lines,
  allOk,
  anyRose,
  loading,
}: {
  lines: ProductionKitForLine[]
  allOk: boolean
  anyRose: boolean
  loading?: boolean
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-ds-line/40 bg-background px-3 py-3 text-xs text-neutral-500 animate-pulse">
        Loading production readiness…
      </div>
    )
  }

  if (lines.length === 0) {
    return (
      <div className="rounded-xl border border-ds-line/40 bg-background px-3 py-3 text-xs text-neutral-500">
        Add line items to evaluate production readiness (die, block, shade links).
      </div>
    )
  }

  const merged = mergeSegments(lines)
  const barTone = loading ? 'border-ds-line/50' : allOk && !anyRose ? 'border-emerald-500/60' : 'border-rose-500/70'
  const fillTone =
    loading ? 'bg-ds-elevated' : allOk && !anyRose ? 'bg-emerald-500' : 'bg-rose-500'

  return (
    <div className="rounded-xl border border-ds-line/40 bg-background px-3 py-3 text-ds-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Production readiness</p>
          <p className="text-xs text-neutral-500 mt-0.5">Die · emboss block · shade card (worst line wins)</p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
            loading
              ? 'bg-ds-card text-neutral-500'
              : allOk && !anyRose
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-rose-500/15 text-rose-400'
          }`}
        >
          {loading ? 'Loading…' : allOk && !anyRose ? 'Kit clear' : 'Action required'}
        </span>
      </div>

      <div className={`mt-3 flex h-2.5 overflow-hidden rounded-full border ${barTone} bg-ds-main`}>
        {merged.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${s.detail}${s.technicalId ? ` (${s.technicalId})` : ''}`}
            className={`flex-1 min-w-[4px] border-r border-border/40 last:border-r-0 transition-colors ${
              s.ok ? fillTone : loading ? 'bg-ds-elevated' : 'bg-rose-500'
            } ${allOk && !anyRose && !loading ? 'opacity-100' : ''}`}
          />
        ))}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-neutral-500">
        {merged.map((s) => (
          <div key={s.key} className="min-w-0">
            <div className="font-semibold text-neutral-500">{s.label}</div>
            <div className={`truncate text-neutral-400 ${techMono}`}>{s.technicalId ?? '—'}</div>
            <div className="truncate text-neutral-500">{s.ok ? 'Ready' : s.detail}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
