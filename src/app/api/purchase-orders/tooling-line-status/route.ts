import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import {
  classifyPoToolingSignal,
  toolingSignalTooltip,
  type DieStatusSnapshot,
  type PoToolingSignal,
} from '@/lib/po-tooling-signal'

export const dynamic = 'force-dynamic'

const lineSchema = z.object({
  key: z.number().int().min(0),
  cartonName: z.string(),
  quantity: z.string(),
  cartonId: z.string(),
  dieMasterId: z.string(),
  toolingUnlinked: z.boolean(),
})

const bodySchema = z.object({
  lines: z.array(lineSchema).max(200),
})

export type ToolingLineStatusResult = {
  key: number
  signal: PoToolingSignal
  dyeNumber: number | null
  location: string | null
  zone: string | null
  tooltip: string
}

/**
 * Batch die-hub readiness for PO line items (signal lights + tooltips).
 * Audit: read-only; actor defaults for downstream bulk sync use session / Anik Dua in actions.
 */
export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { lines } = parsed.data
  const dieIds = Array.from(new Set(lines.map((l) => l.dieMasterId.trim()).filter(Boolean)))

  const dyes =
    dieIds.length === 0
      ? []
      : await db.dye.findMany({
          where: { id: { in: dieIds }, active: true },
          select: {
            id: true,
            dyeNumber: true,
            custodyStatus: true,
            condition: true,
            location: true,
            hubStatusFlag: true,
          },
        })

  const byId = new Map(dyes.map((d) => [d.id, d]))

  const results: ToolingLineStatusResult[] = lines.map((l) => {
    const snap: DieStatusSnapshot | undefined = (() => {
      const id = l.dieMasterId.trim()
      if (!id) return undefined
      const row = byId.get(id)
      if (!row) return undefined
      return {
        custodyStatus: row.custodyStatus,
        condition: row.condition,
        dyeNumber: row.dyeNumber,
        location: row.location,
        hubStatusFlag: row.hubStatusFlag,
      }
    })()

    const signal = classifyPoToolingSignal(
      {
        cartonName: l.cartonName,
        quantity: l.quantity,
        cartonId: l.cartonId,
        dieMasterId: l.dieMasterId,
        toolingUnlinked: l.toolingUnlinked,
      },
      snap,
    )

    const tooltip = toolingSignalTooltip(signal, snap ?? null)

    return {
      key: l.key,
      signal,
      dyeNumber: snap?.dyeNumber ?? null,
      location: snap?.location ?? null,
      zone: snap ? snap.custodyStatus : null,
      tooltip,
    }
  })

  return NextResponse.json({ results })
}
