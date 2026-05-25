'use client'
import { useCartonPOSpecs } from '@/hooks/useCartonPOSpecs'

/**
 * Non-invasive badge for the PO line: warns when the selected carton's
 * physical size has not been warehouse-verified. Self-contained — fetches
 * its own data via useCartonPOSpecs and renders nothing until resolved.
 */
export function CartonSizeVerifiedBadge({
  cartonId,
}: {
  cartonId: string | null | undefined
}) {
  const { data } = useCartonPOSpecs(cartonId ?? null)
  if (!cartonId || !data) return null
  if (data.size_verified) return null
  return (
    <div className="mt-1 w-full rounded bg-[var(--warning-bg)] px-2 py-1 text-xs text-yellow-800">
      Size not warehouse-verified ⚠️
    </div>
  )
}
