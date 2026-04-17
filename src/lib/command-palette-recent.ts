import type {
  CommandPaletteGroupId,
  CommandPaletteResult,
  PaletteRecentGroupId,
  PaletteRecentStored,
} from '@/lib/command-palette-types'

const STORAGE_KEY = 'ci.universalPalette.recent.v1'
const MAX_ITEMS = 5

function isPaletteRecentGroupId(s: string): s is PaletteRecentGroupId {
  return s === 'orders' || s === 'masters' || s === 'tooling'
}

function safeParse(raw: string | null): PaletteRecentStored[] {
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
        typeof (x as PaletteRecentStored).groupId === 'string' &&
        isPaletteRecentGroupId((x as PaletteRecentStored).groupId),
    )
  } catch {
    return []
  }
}

export function loadPaletteRecent(): PaletteRecentStored[] {
  if (typeof window === 'undefined') return []
  return safeParse(window.localStorage.getItem(STORAGE_KEY))
}

export function rememberPaletteNavigation(entry: PaletteRecentStored): void {
  if (typeof window === 'undefined') return
  if (!isPaletteRecentGroupId(entry.groupId)) return
  if (!entry.href.startsWith('/')) return

  const prev = safeParse(window.localStorage.getItem(STORAGE_KEY))
  const next = [
    entry,
    ...prev.filter((p) => p.href !== entry.href && p.resultId !== entry.resultId),
  ].slice(0, MAX_ITEMS)

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent('ci-palette-recent-updated'))
}

export function storedToCommandResult(s: PaletteRecentStored): CommandPaletteResult {
  return {
    id: `recent:${s.href}`,
    title: s.title,
    subtitle: s.subtitle,
    href: s.href,
    titleMono: s.titleMono,
    subtitleMono: s.subtitleMono,
    showMasterIcon: s.showMasterIcon,
    statusBadge: s.statusBadge,
    isRecent: true,
    recentSource: s,
  }
}

export function paletteCategoryToGroupId(label: string): CommandPaletteGroupId | null {
  const u = label.toUpperCase()
  if (u.includes('ORDERS')) return 'orders'
  if (u.includes('MASTERS')) return 'masters'
  if (u.includes('TOOLING')) return 'tooling'
  if (u.includes('BUSINESS') || u.includes('KPI')) return 'business'
  if (u.includes('RECENT')) return 'recent'
  return null
}

export function paletteCategoryToRecentGroupId(label: string): PaletteRecentGroupId | null {
  const g = paletteCategoryToGroupId(label)
  if (g === 'orders' || g === 'masters' || g === 'tooling') return g
  return null
}
