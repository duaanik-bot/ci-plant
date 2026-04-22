'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

type AutoPopulateConfig<T> = {
  storageKey: string
  search: (query: string) => Promise<T[]>
  getId: (item: T) => string
  getLabel: (item: T) => string
  minQueryLength?: number
  /** Debounce for search; default 300. */
  debounceMs?: number
}

type AutoPopulateState<T> = {
  query: string
  setQuery: (v: string) => void
  loading: boolean
  options: T[]
  lastUsed: T[]
  select: (item: T) => void
}

const LAST_USED_LIMIT = 5

export function useAutoPopulate<T>(config: AutoPopulateConfig<T>): AutoPopulateState<T> {
  const { storageKey, search, getId, getLabel, minQueryLength = 1, debounceMs = 300 } = config

  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [options, setOptions] = useState<T[]>([])
  const [lastUsed, setLastUsed] = useState<T[]>([])
  const searchRef = useRef(search)

  useEffect(() => {
    searchRef.current = search
  }, [search])

  // Load last-used from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as { id: string; label: string; data?: T }[]
      if (Array.isArray(parsed)) {
        const items = parsed
          .map((p) => p.data)
          .filter((x): x is T => x != null)
          .slice(0, LAST_USED_LIMIT)
        setLastUsed(items)
      }
    } catch {
      // ignore
    }
  }, [storageKey])

  // Debounced search
  useEffect(() => {
    const normalizedQuery = query.trim()
    if (!normalizedQuery || normalizedQuery.length < minQueryLength) {
      setOptions([])
      setLoading(false)
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await searchRef.current(normalizedQuery)
        if (!cancelled) {
          setOptions(res)
        }
      } catch {
        if (!cancelled) setOptions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, debounceMs)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [minQueryLength, query, debounceMs])

  const select = (item: T) => {
    setOptions([])
    setQuery(getLabel(item))
    setLastUsed((prev) => {
      const existing = prev.filter((x) => getId(x) !== getId(item))
      const next = [item, ...existing].slice(0, LAST_USED_LIMIT)
      if (typeof window !== 'undefined') {
        try {
          const payload = next.map((x) => ({
            id: getId(x),
            label: getLabel(x),
            data: x,
          }))
          window.localStorage.setItem(storageKey, JSON.stringify(payload))
        } catch {
          // ignore
        }
      }
      return next
    })
  }

  const state: AutoPopulateState<T> = useMemo(
    () => ({
      query,
      setQuery,
      loading,
      options,
      lastUsed,
      select,
    }),
    [loading, options, lastUsed, query],
  )

  return state
}
