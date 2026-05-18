'use client'

import { useEffect, useState } from 'react'
import { fetchMiniMasterOptions } from '@/lib/minimasters-options'

// Reads the MiniMasters "Unit" category. Refetches on mount, so any
// form/drawer opened after a create/delete in MiniMasters sees fresh
// values. Falls back to the caller's static list if the category is
// empty or unreachable, so dropdowns never break before the category
// exists in MiniMasters.
export function useUnitOptions(fallback: string[]): { options: string[]; loading: boolean } {
  const [options, setOptions] = useState<string[]>(fallback)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchMiniMasterOptions('Unit')
      .then((values) => {
        if (cancelled) return
        setOptions(values.length > 0 ? values : fallback)
      })
      .catch(() => {
        if (!cancelled) setOptions(fallback)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // fallback is a stable literal at each call site; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { options, loading }
}
