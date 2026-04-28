import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Lines explicitly enqueued for cutting (see job-card finalize action on specOverrides). */
export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const rows = await db.$queryRaw<
    Array<{
      job_card_id: string
      job_card_number: number
      carton_name: string
      quantity: number
      dye_number: number | null
      stage_status: string
      po_number: string
      cutting_stage_id: string
    }>
  >(Prisma.sql`
    SELECT
      j.id AS job_card_id,
      j.job_card_number,
      pli.carton_name,
      pli.quantity,
      d.dye_number,
      psr.status AS stage_status,
      p.po_number,
      psr.id AS cutting_stage_id
    FROM po_line_items pli
    INNER JOIN production_job_cards j ON j.job_card_number = pli.job_card_number
    INNER JOIN production_stage_records psr ON psr.job_card_id = j.id AND psr.stage_name = 'Cutting'
    INNER JOIN purchase_orders p ON p.id = pli.po_id
    LEFT JOIN dyes d ON d.id = pli.dye_id
    WHERE pli.spec_overrides->'executionOrchestration'->>'cuttingQueueEnqueuedAt' IS NOT NULL
    ORDER BY pli.updated_at DESC
    LIMIT 250
  `)

  return NextResponse.json(rows)
}
