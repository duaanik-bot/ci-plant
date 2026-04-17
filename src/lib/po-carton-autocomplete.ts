'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PastingStyle } from '@prisma/client'

/** Shape returned from `GET /api/cartons` and used by PO line-item autocomplete. */
export type PoCartonCatalogItem = {
  id: string
  cartonName: string
  customerId: string
  cartonSize: string
  boardGrade?: string | null
  gsm?: number | null
  paperType?: string | null
  rate?: number | null
  gstPct: number
  coatingType?: string | null
  embossingLeafing?: string | null
  foilType?: string | null
  artworkCode?: string | null
  backPrint?: string | null
  dyeId?: string | null
  dieMasterId?: string | null
  /** Product master pasting (canonical). */
  pastingStyle?: PastingStyle | null
  /** Label from Die Master (`pastingStyle` or `dyeType`). */
  masterDieType?: string | null
  toolingDimsLabel?: string | null
  toolingUnlinked?: boolean
  specialInstructions?: string | null
}

export const PO_CARTON_RECENT_LIMIT = 5

export function mapApiRowToPoCarton(raw: Record<string, unknown>): PoCartonCatalogItem {
  return {
    id: String(raw.id ?? ''),
    cartonName: String(raw.cartonName ?? ''),
    customerId: String(raw.customerId ?? ''),
    cartonSize: String(raw.cartonSize ?? ''),
    boardGrade: (raw.boardGrade as string | null | undefined) ?? null,
    gsm: raw.gsm != null ? Number(raw.gsm) : null,
    paperType: (raw.paperType as string | null | undefined) ?? null,
    rate: raw.rate != null ? Number(raw.rate) : null,
    gstPct: raw.gstPct != null ? Number(raw.gstPct) : 5,
    coatingType: (raw.coatingType as string | null | undefined) ?? null,
    embossingLeafing: (raw.embossingLeafing as string | null | undefined) ?? null,
    foilType: (raw.foilType as string | null | undefined) ?? null,
    artworkCode: (raw.artworkCode as string | null | undefined) ?? null,
    backPrint: (raw.backPrint as string | null | undefined) ?? null,
    dyeId: (raw.dyeId as string | null | undefined) ?? null,
    dieMasterId: (raw.dieMasterId as string | null | undefined) ?? null,
    pastingStyle: (raw.pastingStyle as PastingStyle | null | undefined) ?? null,
    masterDieType: (raw.masterDieType as string | null | undefined) ?? null,
    toolingDimsLabel: (raw.toolingDimsLabel as string | null | undefined) ?? null,
    toolingUnlinked: raw.toolingUnlinked === true,
    specialInstructions: (raw.specialInstructions as string | null | undefined) ?? null,
  }
}

export function usePoRecentCartons(customerId: string | undefined) {
  const storageKey = customerId ? `po-carton-${customerId}` : 'po-carton-none'
  const [lastUsed, setLastUsed] = useState<PoCartonCatalogItem[]>([])

  useEffect(() => {
    if (!customerId || typeof window === 'undefined') {
      setLastUsed([])
      return
    }
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) {
        setLastUsed([])
        return
      }
      const parsed = JSON.parse(raw) as { id: string; data?: PoCartonCatalogItem }[]
      if (!Array.isArray(parsed)) {
        setLastUsed([])
        return
      }
      const items = parsed
        .map((p) => p.data)
        .filter((x): x is PoCartonCatalogItem => x != null)
        .slice(0, PO_CARTON_RECENT_LIMIT)
      setLastUsed(items.filter((c) => c.customerId === customerId))
    } catch {
      setLastUsed([])
    }
  }, [storageKey, customerId])

  const pushRecent = useCallback(
    (item: PoCartonCatalogItem) => {
      setLastUsed((prev) => {
        const next = [item, ...prev.filter((x) => x.id !== item.id)].slice(0, PO_CARTON_RECENT_LIMIT)
        try {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify(next.map((x) => ({ id: x.id, label: x.cartonName, data: x }))),
          )
        } catch {
          // ignore
        }
        return next
      })
    },
    [storageKey],
  )

  return { lastUsed, pushRecent }
}
