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
        <p className="text-[9px] font-bold uppercase tracking-wider text-red-400 mb-1">SYNC REQUIRED</p>
        <div
          id={`paste-warn-${lineIndex}`}
          className="pointer-events-none absolute bottom-full left-0 z-[60] mb-1.5 hidden w-max max-w-[16rem] rounded-md border border-red-800 bg-red-600 px-2.5 py-2 text-[10px] font-semibold leading-snug text-foreground shadow-xl group-hover/pasteWarn:block"
          role="tooltip"
        >
          Critical: Product Master has no Pasting Style. Choose Lock Bottom or BSO and sync to master before
          production handoff.
        </div>
        <button
          type="button"
          disabled={savingToMaster}
          onClick={() => setPopoverOpenForLine(open ? null : lineIndex)}
          className={`w-full flex items-center justify-between gap-1 rounded-md border-2 border-dashed border-red-500 bg-red-950/35 px-2 py-1 text-left ${pasteErr ? inputErr : ''} disabled:opacity-50`}
          aria-expanded={open}
          aria-describedby={`paste-warn-${lineIndex}`}
        >
          <span className="text-[10px] font-semibold text-red-100 leading-tight">
            {pastingStyleLabel(displayStyle)}
          </span>
          <span className="text-[10px] text-red-200/90 shrink-0" aria-hidden>
            {open ? '▴' : '▾'}
          </span>
        </button>
        {open ? (
          <select
            aria-label="Save pasting style to Product Master"
            disabled={savingToMaster}
            className={`mt-1 w-full ${inputCls} border-red-700/60 bg-red-950/30 text-red-50`}
            value=""
            onChange={(e) => {
              const v = e.target.value
              if (v === PastingStyle.LOCK_BOTTOM) onSaveToMaster(PastingStyle.LOCK_BOTTOM)
              if (v === PastingStyle.BSO) onSaveToMaster(PastingStyle.BSO)
              e.target.value = ''
            }}
          >
            <option value="">Lock Bottom or BSO — save to master…</option>
            <option value={PastingStyle.LOCK_BOTTOM}>{pastingStyleLabel(PastingStyle.LOCK_BOTTOM)}</option>
            <option value={PastingStyle.BSO}>{pastingStyleLabel(PastingStyle.BSO)}</option>
          </select>
        ) : null}
        {pasteErr ? <p className="text-[10px] text-red-400 mt-0.5">{pasteErr}</p> : null}
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
