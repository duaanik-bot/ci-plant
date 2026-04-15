import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { shadeCardCreateSchema } from '@/lib/inventory-hub-schemas'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const rows = await db.shadeCard.findMany({
      orderBy: { shadeCode: 'asc' },
    })

    const payload = rows.map((s) => ({
      id: s.id,
      shadeCode: s.shadeCode,
      productMaster: s.productMaster,
      masterArtworkRef: s.masterArtworkRef,
      approvalDate: s.approvalDate?.toISOString().slice(0, 10) ?? null,
      inkComponent: s.inkComponent,
      currentHolder: s.currentHolder,
      impressionCount: s.impressionCount,
      custodyStatus: s.custodyStatus,
      issuedMachineId: s.issuedMachineId,
      issuedOperator: s.issuedOperator,
      issuedAt: s.issuedAt?.toISOString() ?? null,
    }))

    return new NextResponse(safeJsonStringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/shade-cards GET]', e)
    return NextResponse.json({ error: 'Failed to load shade cards' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { error } = await requireAuth()
    if (error) return error

    let raw = ''
    try {
      raw = await req.text()
    } catch {
      return NextResponse.json({ error: 'Could not read request body' }, { status: 400 })
    }
    const body = safeJsonParse<Record<string, unknown>>(raw, {})
    const parsed = shadeCardCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { autoGenerateCode, shadeCode: manualCode, productMaster, masterArtworkRef, approvalDate, inkComponent, currentHolder } =
      parsed.data

    let created
    try {
      created = await db.$transaction(async (tx) => {
        let shadeCode = manualCode?.trim()
        if (autoGenerateCode || !shadeCode) {
          const count = await tx.shadeCard.count()
          let n = count + 1
          let allocated = ''
          for (let attempt = 0; attempt < 50; attempt++) {
            const code = `SC-${String(n).padStart(4, '0')}`
            const exists = await tx.shadeCard.findUnique({ where: { shadeCode: code } })
            if (!exists) {
              allocated = code
              break
            }
            n += 1
          }
          if (!allocated) throw new Error('Could not allocate shade code')
          shadeCode = allocated
        }

        const dup = await tx.shadeCard.findUnique({ where: { shadeCode: shadeCode! } })
        if (dup) {
          throw new Error('DUPLICATE_SHADE')
        }

        return tx.shadeCard.create({
          data: {
            shadeCode: shadeCode!,
            productMaster: productMaster ?? null,
            masterArtworkRef: masterArtworkRef ?? null,
            approvalDate: approvalDate ? new Date(approvalDate) : null,
            inkComponent: inkComponent ?? null,
            currentHolder: currentHolder ?? null,
          },
        })
      })
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'DUPLICATE_SHADE') {
        return NextResponse.json({ error: 'Shade code already exists' }, { status: 409 })
      }
      throw e
    }

    return NextResponse.json({
      id: created.id,
      shadeCode: created.shadeCode,
    })
  } catch (e) {
    console.error('[inventory-hub/shade-cards POST]', e)
    return NextResponse.json({ error: 'Failed to create shade card' }, { status: 500 })
  }
}
