'use client'

type DeliveryDateInputProps = {
  value: string
  onValueChange: (ymd: string) => void
  onUserOverride: () => void
  showCustomBadge: boolean
  autoHint: string | null
  suggestedYmd: string | null
  onUseAutoSuggestion: () => void
  inputClassName?: string
}

/**
 * PO “Delivery required by” with auto-suggest hint and Custom override UX.
 * Used on New PO (`purchase-orders/new`); named per POHeader/DeliveryDateInput spec.
 */
export function DeliveryDateInput({
  value,
  onValueChange,
  onUserOverride,
  showCustomBadge,
  autoHint,
  suggestedYmd,
  onUseAutoSuggestion,
  inputClassName = 'w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white',
}: DeliveryDateInputProps) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <label className="block text-slate-400">Delivery required by</label>
        {showCustomBadge ? (
          <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300/95 border border-amber-600/70 rounded px-1.5 py-0.5">
            Custom
          </span>
        ) : null}
      </div>
      <input
        type="date"
        value={value}
        onChange={(e) => {
          onUserOverride()
          onValueChange(e.target.value)
        }}
        className={inputClassName}
      />
      {autoHint ? (
        <p className="mt-1 text-[11px] text-slate-500 leading-snug">{autoHint}</p>
      ) : null}
      {showCustomBadge && suggestedYmd ? (
        <button
          type="button"
          onClick={onUseAutoSuggestion}
          className="mt-1 text-[11px] text-sky-400 hover:text-sky-300 underline"
        >
          Use auto-suggestion ({suggestedYmd})
        </button>
      ) : null}
    </div>
  )
}
