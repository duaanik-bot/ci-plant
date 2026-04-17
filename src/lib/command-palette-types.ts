import type { PastingStyle } from '@prisma/client'

export type CommandPaletteGroupId = 'orders' | 'tooling' | 'masters' | 'business' | 'recent'

/** Stored navigation targets only (not UI-only groups). */
export type PaletteRecentGroupId = Exclude<CommandPaletteGroupId, 'recent' | 'business'>

export type PaletteRecentStored = {
  href: string
  title: string
  subtitle?: string
  /** Original result id e.g. po-uuid, carton-uuid, die-uuid */
  resultId: string
  groupId: PaletteRecentGroupId
  titleMono?: boolean
  subtitleMono?: boolean
  showMasterIcon?: boolean
  statusBadge?: { text: string; className: string }
}

export type CommandPaletteResult = {
  id: string
  title: string
  subtitle?: string
  href: string
  /** PO / job status chip */
  statusBadge?: { text: string; className: string }
  pastingStyle?: PastingStyle | null
  /** Use JetBrains / mono for industrial cockpit (PO #, die id, etc.) */
  titleMono?: boolean
  /** Mono for dimension lines in subtitle */
  subtitleMono?: boolean
  /** Show product-master icon in palette row */
  showMasterIcon?: boolean
  /** Row from local recent history */
  isRecent?: boolean
  /** Round-trip payload for persisting recent order on click */
  recentSource?: PaletteRecentStored
}

export type CommandPaletteGroup = {
  id: CommandPaletteGroupId
  label: string
  results: CommandPaletteResult[]
}
