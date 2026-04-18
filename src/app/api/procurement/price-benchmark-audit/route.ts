import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  boardGrade: z.string().min(1).max(200),
  gsm: z.coerce.number().int().positive(),
  variancePct: z.coerce.number(),
  currentRatePerKg: z.coerce.number().positive(),
  benchmarkRatePerKg: z.coerce.number().positive(),
  benchmarkSupplierName: z.string().max(200).optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const v = Math.round(parsed.data.variancePct * 100) / 100
  const message = `Price Benchmarked against Global Ledger - Variance Detected: ${v}%.`
  const actor = user!.name?.trim() || 'User'

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'procurement_price_benchmark',
    recordId: `bench-${parsed.data.gsm}-${parsed.data.boardGrade.slice(0, 40)}`,
    newValue: {
      ...parsed.data,
      message,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'procurement_price_benchmark_variance',
    module: 'Procurement',
    recordId: 'price-benchmark',
    operatorLabel: actor,
    payload: {
      message,
      boardGrade: parsed.data.boardGrade,
      gsm: parsed.data.gsm,
      variancePct: v,
      currentRatePerKg: parsed.data.currentRatePerKg,
      benchmarkRatePerKg: parsed.data.benchmarkRatePerKg,
      benchmarkSupplierName: parsed.data.benchmarkSupplierName ?? null,
    },
  })

  return NextResponse.json({ ok: true, message })
}
