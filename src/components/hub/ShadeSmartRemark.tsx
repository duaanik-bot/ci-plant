'use client'

export function ShadeSmartRemark({
  text,
  editedBy,
  editedAtIso,
  updatedAtIso,
  monoClass,
}: {
  text: string | null | undefined
  editedBy: string | null | undefined
  editedAtIso: string | null | undefined
  updatedAtIso: string | null | undefined
  monoClass: string
}) {
  const full = (text ?? '').trim()
  if (!full) {
    return <span className={`text-neutral-600 ${monoClass}`}>—</span>
  }
  const short = full.length > 20 ? `${full.slice(0, 20)}…` : full
  const by = editedBy?.trim() || '—'
  const ts = editedAtIso?.trim() || updatedAtIso?.trim() || null
  const tsLabel = ts ? new Date(ts).toLocaleString() : '—'
  return (
    <div className="group relative max-w-[7rem] font-sans">
      <span className="block truncate text-neutral-500 cursor-default">{short}</span>
      <div
        className="pointer-events-none invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute z-[80] bottom-full left-0 mb-1 w-72 rounded-lg border border-ds-line/50 bg-ds-main p-2 text-xs shadow-xl text-ds-ink"
        role="tooltip"
      >
        <p className="whitespace-pre-wrap text-ds-ink">{full}</p>
        <p className={`mt-1 text-neutral-500 ${monoClass}`}>Updated by {by}</p>
        <p className={`text-neutral-500 ${monoClass}`}>{tsLabel}</p>
      </div>
    </div>
  )
}
