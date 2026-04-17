import type { PastingStyle } from '@prisma/client'

export type CommandPaletteGroupId = 'orders' | 'tooling' | 'masters' | 'business'

export type CommandPaletteResult = {
  id: string
  title: string
  subtitle?: string
  href: string
  /** PO / job status chip */
  statusBadge?: { text: string; className: string }
  pastingStyle?: PastingStyle | null
}

export type CommandPaletteGroup = {
  id: CommandPaletteGroupId
  label: string
  results: CommandPaletteResult[]
}
