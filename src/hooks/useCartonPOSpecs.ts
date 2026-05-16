'use client'
import { useEffect, useState } from 'react'

export type CartonPOSpecs = Record<string, unknown> & {
  carton_name: string
  size_verified: boolean
}

export function useCartonPOSpecs(cartonId: string | null) {
  const [data, setData] = useState<CartonPOSpecs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cartonId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/cartons/${cartonId}/po-specs`)
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error((j?.error as string) ?? 'Failed')
        return j as CartonPOSpecs
      })
      .then((j) => {
        if (!cancelled) setData(j)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cartonId])

  return { data, loading, error }
}
