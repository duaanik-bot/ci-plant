'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { PastingStyle } from '@prisma/client'
import { PO_MANUAL_PASTING_VALUES, pastingStyleLabel } from '@/lib/pasting-style'

export type PoLinePastingStyleCellProps = {
  lineIndex: number
  cartonId: string
  pastingStyle: string
  masterPastingStyleMissing: boolean
  /** System-filled from master — slightly dimmed vs user-edited */
  ghostFromMaster?: boolean
  pasteErr?: string
  inputCls: string
  inputErr: string
  savingToMaster: boolean
  popoverOpenForLine: number | null
  setPopoverOpenForLine: (idx: number | null) => void
  onPastingSelectChange: (value: string) => void
  onSaveToMaster: (style: PastingStyle) => void
}

function badgeClassForLine(style: string): string {
  if (style === 'BSO') {
    return 'inline-flex items-center justify-center rounded-md bg-violet-600/75 px-2 py-1 text-[11px] font-bold text-primary-foreground shadow-sm ring-1 ring-inset ring-violet-300/40 transition-opacity hover:bg-violet-600/90'
  }
  return 'inline-flex items-center justify-center rounded-md bg-indigo-600/75 px-2 py-1 text-[11px] font-bold text-primary-foreground shadow-sm ring-1 ring-inset ring-indigo-300/40 transition-opacity hover:bg-indigo-600/90'
}

export function PoLinePastingStyleCell({
  lineIndex,
  cartonId,
  pastingStyle,
  masterPastingStyleMissing,
  ghostFromMaster = false,
  pasteErr,
  inputCls,
  inputErr,
  savingToMaster,
  popoverOpenForLine,
  setPopoverOpenForLine,
  onPastingSelectChange,
  onSaveToMaster,
}: PoLinePastingStyleCellProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const open = popoverOpenForLine === lineIndex

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current
      if (el && !el.contains(e.target as Node)) setPopoverOpenForLine(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, setPopoverOpenForLine])

  if (!cartonId) {
    return (
      <div className="min-w-[7rem]">
        <select
          value={pastingStyle}
          onChange={(e) => onPastingSelectChange(e.target.value)}
          className={`${inputCls} ${pasteErr ? inputErr : ''}`}
        >
          <option value="">Select…</option>
          {PO_MANUAL_PASTING_VALUES.map((p) => (
            <option key={p} value={p}>
              {pastingStyleLabel(p)}
            </option>
          ))}
        </select>
        {pasteErr ? <p className="text-[10px] text-red-400 mt-0.5">{pasteErr}</p> : null}
      </div>
    )
  }

  if (masterPastingStyleMissing) {
    const displayStyle =
      pastingStyle === 'BSO' ? PastingStyle.BSO : PastingStyle.LOCK_BOTTOM
    return (
      <div ref={wrapRef} className="group/pasteWarn relative min-w-[9rem]">
        <p className="mb-1 text-[10px] text-ds-ink-faint">Choose a style, then use Save to master.</p>
        <div
          id={`paste-warn-${lineIndex}`}
          className="pointer-events-none absolute bottom-full left-0 z-[60] mb-1.5 hidden w-max max-w-[14rem] rounded-ds-sm border border-ds-line bg-ds-card px-2.5 py-2 text-[10px] font-medium leading-snug text-ds-ink-muted shadow-xl group-hover/pasteWarn:block"
          role="tooltip"
        >
          Lock Bottom or BSO, then save to product master. Edits here still apply to this PO.
        </div>
        <button
          type="button"
          disabled={savingToMaster}
          onClick={() => setPopoverOpenForLine(open ? null : lineIndex)}
          className={`flex w-full items-center justify-between gap-1 rounded-ds-sm border border-ds-warning/35 bg-ds-warning/5 px-2 py-1.5 text-left transition duration-200 hover:border-ds-warning/50 hover:bg-ds-warning/10 ${pasteErr ? inputErr : ''} disabled:opacity-50`}
          aria-expanded={open}
          aria-describedby={`paste-warn-${lineIndex}`}
        >
          <span className="text-[12px] font-medium leading-tight text-ds-ink">
            {pastingStyleLabel(displayStyle)}
          </span>
          <span className="shrink-0 text-[10px] text-ds-ink-faint" aria-hidden>
            {open ? '▴' : '▾'}
          </span>
        </button>
        {open ? (
          <select
            aria-label="Save pasting style to product master"
            disabled={savingToMaster}
            className={`mt-1 w-full ${inputCls} border-ds-line bg-ds-elevated/80 text-ds-ink`}
            value=""
            onChange={(e) => {
              const v = e.target.value
              if (v === PastingStyle.LOCK_BOTTOM) onSaveToMaster(PastingStyle.LOCK_BOTTOM)
              if (v === PastingStyle.BSO) onSaveToMaster(PastingStyle.BSO)
              e.target.value = ''
            }}
          >
            <option value="">Save to master…</option>
            <option value={PastingStyle.LOCK_BOTTOM}>{pastingStyleLabel(PastingStyle.LOCK_BOTTOM)}</option>
            <option value={PastingStyle.BSO}>{pastingStyleLabel(PastingStyle.BSO)}</option>
          </select>
        ) : null}
        {pasteErr ? <p className="text-[10px] text-ds-error mt-0.5">{pasteErr}</p> : null}
      </div>
    )
  }

  const linkedStyle = pastingStyle === 'BSO' ? PastingStyle.BSO : PastingStyle.LOCK_BOTTOM
  if (!pastingStyle?.trim()) {
    return (
      <div className={`min-w-[7rem] text-xs text-slate-400 ${ghostFromMaster ? 'opacity-90' : ''}`}>
        Loading…
        {pasteErr ? <p className="text-[10px] text-red-400 mt-0.5">{pasteErr}</p> : null}
      </div>
    )
  }
  return (
    <div className={`min-w-[7rem] ${ghostFromMaster ? 'opacity-90' : ''}`}>
      <Link
        href={`/masters/cartons/${cartonId}`}
        className={badgeClassForLine(pastingStyle)}
        title="Open Product Master (die / tooling specs)"
      >
        {pastingStyleLabel(linkedStyle)}
      </Link>
      {pasteErr ? <p className="text-[10px] text-red-400 mt-0.5">{pasteErr}</p> : null}
    </div>
  )
}
