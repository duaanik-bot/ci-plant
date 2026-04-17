import type { PaletteRecentStored } from '@/lib/command-palette-types'

const PINS_KEY = 'ci.directorWorkspace.pins.v1'
const COLLAPSED_KEY = 'ci.directorWorkspace.collapsed.v1'
const MAX_PINS = 20

function parsePins(raw: string | null): PaletteRecentStored[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (x): x is PaletteRecentStored =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as PaletteRecentStored).href === 'string' &&
        typeof (x as PaletteRecentStored).title === 'string' &&
        typeof (x as PaletteRecentStored).resultId === 'string' &&
        ((x as PaletteRecentStored).groupId === 'orders' ||
          (x as PaletteRecentStored).groupId === 'masters' ||
          (x as PaletteRecentStored).groupId === 'tooling'),
    )
  } catch {
    return []
  }
}

export function loadWorkspacePins(): PaletteRecentStored[] {
  if (typeof window === 'undefined') return []
  return parsePins(window.localStorage.getItem(PINS_KEY))
}

export function saveWorkspacePins(pins: PaletteRecentStored[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PINS_KEY, JSON.stringify(pins.slice(0, MAX_PINS)))
  window.dispatchEvent(new CustomEvent('ci-director-workspace-updated'))
}

export function toggleWorkspacePin(entry: PaletteRecentStored): void {
  const prev = loadWorkspacePins()
  const exists = prev.some((p) => p.href === entry.href || p.resultId === entry.resultId)
  const next = exists
    ? prev.filter((p) => p.href !== entry.href && p.resultId !== entry.resultId)
    : [entry, ...prev].slice(0, MAX_PINS)
  saveWorkspacePins(next)
}

export function loadWorkspaceCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(COLLAPSED_KEY) === '1'
}

export function saveWorkspaceCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  window.dispatchEvent(new CustomEvent('ci-director-workspace-updated'))
}
