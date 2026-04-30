'use client'

import { useEffect, useState } from 'react'

export type UiDensity = 'dense' | 'comfortable'

const UI_DENSITY_KEY = 'ci-ui-density'
const UI_DENSITY_EVENT = 'ci-ui-density-change'

export function getStoredUiDensity(): UiDensity {
  if (typeof window === 'undefined') return 'dense'
  return window.localStorage.getItem(UI_DENSITY_KEY) === 'comfortable'
    ? 'comfortable'
    : 'dense'
}

export function setStoredUiDensity(next: UiDensity): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(UI_DENSITY_KEY, next)
  window.dispatchEvent(new CustomEvent<UiDensity>(UI_DENSITY_EVENT, { detail: next }))
}

export function useUiDensity(): [UiDensity, (next: UiDensity) => void] {
  const [density, setDensity] = useState<UiDensity>(() => getStoredUiDensity())

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === UI_DENSITY_KEY) setDensity(getStoredUiDensity())
    }
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<UiDensity>).detail
      if (detail === 'dense' || detail === 'comfortable') setDensity(detail)
      else setDensity(getStoredUiDensity())
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(UI_DENSITY_EVENT, onCustom)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(UI_DENSITY_EVENT, onCustom)
    }
  }, [])

  const update = (next: UiDensity) => {
    setDensity(next)
    setStoredUiDensity(next)
  }

  return [density, update]
}
