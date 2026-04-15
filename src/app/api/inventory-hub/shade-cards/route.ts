import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { shadeCardCreateSchema } from '@/lib/inventory-hub-schemas'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import { createShadeCardEvent, SHADE_CARD_ACTION } from '@/lib/shade-card-events'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const rows = await db.shadeCard.findMany({
      orderBy: { createdAt: 'desc' },
    })

    const payload = rows.map((s) => {
      const custody = s.custodyStatus ?? ''
      let cardStatusLabel = custody
      if (custody === 'in_stock') cardStatusLabel = 'In-Stock'
      else if (custody === 'on_floor') cardStatusLabel = 'Issued'
      else if (custody === 'at_vendor') cardStatusLabel = 'At vendor'

      let locationLabel = '—'
      if (custody === 'in_stock') locationLabel = 'Rack'
      else if (custody === 'at_vendor') locationLabel = 'Vendor'
      else if (custody === 'on_floor') locationLabel = s.currentHolder?.trim() || 'On floor'

      return {
        id: s.id,
        shadeCode: s.shadeCode,
        productMaster: s.productMaster,
        masterArtworkRef: s.masterArtworkRef,
        remarks: s.remarks,
        approvalDate: s.approvalDate?.toISOString().slice(0, 10) ?? null,
        inkComponent: s.inkComponent,
        currentHolder: s.currentHolder,
        impressionCount: s.impressionCount,
        custodyStatus: s.custodyStatus,
        cardStatusLabel,
        locationLabel,
        issuedMachineId: s.issuedMachineId,
        issuedOperator: s.issuedOperator,
        issuedAt: s.issuedAt?.toISOString() ?? null,
        entryDate: s.createdAt.toISOString().slice(0, 10),
        createdAt: s.createdAt.toISOString(),
      }
    })

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

    const {
      autoGenerateCode,
      shadeCode: manualCode,
      productMaster,
      masterArtworkRef,
      quantity = 1,
      remarks,
      approvalDate,
      inkComponent,
      currentHolder,
    } = parsed.data

    let createdItems: { id: string; shadeCode: string }[]
    try {
      createdItems = await db.$transaction(async (tx) => {
        const items: { id: string; shadeCode: string }[] = []
        let nextBase = (await tx.shadeCard.count()) + 1

        for (let i = 0; i < quantity; i++) {
          let shadeCode = manualCode?.trim()
          if (autoGenerateCode || !shadeCode) {
            let allocated = ''
            let n = nextBase
            for (let attempt = 0; attempt < 200; attempt++) {
              const code = `SC-${String(n).padStart(4, '0')}`
              const exists = await tx.shadeCard.findUnique({ where: { shadeCode: code } })
              if (!exists) {
                allocated = code
                nextBase = n + 1
                break
              }
              n += 1
            }
            if (!allocated) throw new Error('Could not allocate shade code')
            shadeCode = allocated
          } else if (quantity > 1) {
            throw new Error('MANUAL_CODE_BATCH')
          }

          const dup = await tx.shadeCard.findUnique({ where: { shadeCode: shadeCode! } })
          if (dup) {
            throw new Error('DUPLICATE_SHADE')
          }

          const row = await tx.shadeCard.create({
            data: {
              shadeCode: shadeCode!,
              productMaster: productMaster ?? null,
              masterArtworkRef: masterArtworkRef ?? null,
              approvalDate: approvalDate ? new Date(approvalDate) : null,
              inkComponent: inkComponent ?? null,
              currentHolder: currentHolder ?? null,
              remarks: remarks?.trim() || null,
            },
          })
          await createShadeCardEvent(tx, {
            shadeCardId: row.id,
            actionType: SHADE_CARD_ACTION.CREATED,
            details: {
              productMaster,
              masterArtworkRef,
              remarks: remarks?.trim() || null,
              quantityIndex: i + 1,
              quantityTotal: quantity,
            },
          })
          items.push({ id: row.id, shadeCode: row.shadeCode })
        }
        return items
      })
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'DUPLICATE_SHADE') {
        return NextResponse.json({ error: 'Shade code already exists' }, { status: 409 })
      }
      if (e instanceof Error && e.message === 'MANUAL_CODE_BATCH') {
        return NextResponse.json(
          { error: 'Manual shade code cannot be used when quantity is greater than 1' },
          { status: 400 },
        )
      }
      throw e
    }

    return NextResponse.json({
      items: createdItems,
      count: createdItems.length,
      id: createdItems[0]?.id,
      shadeCode: createdItems[0]?.shadeCode,
    })
  } catch (e) {
    console.error('[inventory-hub/shade-cards POST]', e)
    return NextResponse.json({ error: 'Failed to create shade card' }, { status: 500 })
  }
}
