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
  inputClassName = 'w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground',
}: DeliveryDateInputProps) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <label className="block text-ds-ink-muted">Delivery required by</label>
        {showCustomBadge ? (
          <span className="text-xs font-bold uppercase tracking-wide text-ds-warning/95 border border-ds-warning/50 rounded px-1.5 py-0.5">
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
        <p className="mt-1 text-xs text-ds-ink-faint leading-snug">{autoHint}</p>
      ) : null}
      {showCustomBadge && suggestedYmd ? (
        <button
          type="button"
          onClick={onUseAutoSuggestion}
          className="mt-1 text-xs text-sky-700 hover:text-sky-800 underline dark:text-sky-300 dark:hover:text-sky-200"
        >
          Use auto-suggestion ({suggestedYmd})
        </button>
      ) : null}
    </div>
  )
}
