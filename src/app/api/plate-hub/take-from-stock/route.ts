import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  requirementId: z.string().uuid(),
  plateStoreId: z.string().uuid(),
  colourNames: z.array(z.string().min(1)).min(1),
})

type ColourRow = {
  name?: string
  status?: string
  type?: string
  rackLocation?: string | null
  slotNumber?: string | null
  condition?: string | null
}

function normColourKey(s: string): string {
  return s
    .replace(/\s*\((new|existing)\)\s*$/i, '')
    .trim()
    .toLowerCase()
}

function normHubKey(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase()
}

function recountPlateMetrics(colours: ColourRow[]) {
  const active = colours.filter((c) => String(c?.status ?? '').toLowerCase() !== 'destroyed')
  const numberOfColours = active.length
  const totalPlates = active.length
  const newPlates = active.filter((c) => String(c?.status ?? '').toLowerCase() === 'new').length
  const oldPlates = active.filter((c) => {
    const s = String(c?.status ?? '').toLowerCase()
    return s === 'old' || s === 'returned'
  }).length
  return { numberOfColours, totalPlates, newPlates, oldPlates }
}

async function nextPlateSetCode(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PS-${year}-`
  const last = await tx.plateStore.findFirst({
    where: { plateSetCode: { startsWith: prefix } },
    orderBy: { plateSetCode: 'desc' },
    select: { plateSetCode: true },
  })
  const lastSeq = last ? parseInt(last.plateSetCode.replace(prefix, ''), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

async function nextPlateSerial(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PL-SN-${year}-`
  const last = await tx.plateStore.findFirst({
    where: { serialNumber: { startsWith: prefix } },
    orderBy: { serialNumber: 'desc' },
    select: { serialNumber: true },
  })
  const lastSeq = last?.serialNumber ? parseInt(last.serialNumber.replace(prefix, ''), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

class TakeStockHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TakeStockHttpError'
  }
}

/**
 * Pull selected colour channels from a live rack plate set into a new READY_ON_FLOOR custody row,
 * update or retire the source set, and shrink / complete the triage requirement.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'Invalid request: requirement id, plate set id, and at least one colour name are required.',
      },
      { status: 400 },
    )
  }

  const { requirementId, plateStoreId, colourNames } = parsed.data
  const wanted = new Set(colourNames.map((n) => normColourKey(n)).filter(Boolean))

  try {
    const result = await db.$transaction(async (tx) => {
      const reqRow = await tx.plateRequirement.findUnique({ where: { id: requirementId } })
      if (!reqRow) throw new TakeStockHttpError('Requirement not found', 404)

      if (reqRow.triageChannel != null) {
        throw new TakeStockHttpError(
          'This job is not in incoming triage (clear lane dispatch first).',
          409,
        )
      }

      const triageStatuses = new Set(['pending', 'ctp_notified', 'plates_ready'])
      if (!triageStatuses.has(reqRow.status)) {
        throw new TakeStockHttpError('This requirement cannot take stock in its current status.', 409)
      }

      const plate = await tx.plateStore.findUnique({ where: { id: plateStoreId } })
      if (!plate) throw new TakeStockHttpError('Plate set not found', 404)

      const rackOk = ['ready', 'returned', 'in_stock'].includes(plate.status)
      if (!rackOk) {
        throw new TakeStockHttpError('Plate set is not in live inventory.', 409)
      }

      const jobAw = normHubKey(reqRow.artworkCode)
      if (jobAw) {
        if (normHubKey(plate.artworkCode) !== jobAw) {
          throw new TakeStockHttpError('Plate set AW code does not match this triage job.', 409)
        }
      } else if (normHubKey(plate.cartonName) !== normHubKey(reqRow.cartonName)) {
        throw new TakeStockHttpError('Plate set carton does not match this triage job.', 409)
      }

      const needed = Array.isArray(reqRow.coloursNeeded)
        ? (reqRow.coloursNeeded as { name: string; isNew?: boolean }[])
        : []
      const neededNorm = new Set(needed.map((x) => normColourKey(x.name)))
      for (const w of Array.from(wanted)) {
        if (!neededNorm.has(w)) {
          throw new TakeStockHttpError(
            `Colour is not part of this job’s requirement: ${colourNames.find((n) => normColourKey(n) === w) ?? w}`,
            400,
          )
        }
      }

      const sourceColours = (Array.isArray(plate.colours) ? plate.colours : []) as ColourRow[]

      const pulledForCustody: ColourRow[] = []
      for (const row of sourceColours) {
        const name = String(row?.name ?? '').trim()
        const st = String(row?.status ?? '').toLowerCase()
        if (!name || st === 'destroyed') continue
        if (!wanted.has(normColourKey(name))) continue
        pulledForCustody.push({
          ...row,
          rackLocation: null,
          slotNumber: null,
        })
      }

      const pulledNorms = new Set(pulledForCustody.map((r) => normColourKey(String(r.name))))
      for (const w of Array.from(wanted)) {
        if (!pulledNorms.has(w)) {
          throw new TakeStockHttpError(
            'One or more colours are not available on this plate set (check rack / partial scrap).',
            400,
          )
        }
      }

      const nowIso = new Date().toISOString()
      const nextSource = sourceColours.map((row) => {
        const name = String(row?.name ?? '').trim()
        const st = String(row?.status ?? '').toLowerCase()
        if (!name || st === 'destroyed') return row
        if (wanted.has(normColourKey(name))) {
          return {
            ...row,
            status: 'destroyed',
            destroyedAt: nowIso,
            destroyReason: 'issued_from_rack_to_custody',
          }
        }
        return row
      })

      const srcMetrics = recountPlateMetrics(nextSource)
      const fullyGone = srcMetrics.numberOfColours === 0

      const plateSetCode = await nextPlateSetCode(tx)
      const serialNumber = await nextPlateSerial(tx)
      const custodyMetrics = recountPlateMetrics(pulledForCustody)

      await tx.plateStore.update({
        where: { id: plateStoreId },
        data: {
          colours: nextSource as object[],
          numberOfColours: srcMetrics.numberOfColours,
          totalPlates: srcMetrics.totalPlates,
          newPlates: srcMetrics.newPlates,
          oldPlates: srcMetrics.oldPlates,
          ...(fullyGone
            ? {
                status: 'destroyed',
                destroyedAt: new Date(),
                destroyedBy: user!.id,
                destroyedReason: 'All channels moved to custody floor from rack',
                hubCustodySource: null,
                hubPreviousStatus: null,
              }
            : {
                lastStatusUpdatedAt: new Date(),
              }),
        },
      })

      const custodyPlate = await tx.plateStore.create({
        data: {
          plateSetCode,
          serialNumber,
          cartonName: plate.cartonName,
          artworkCode: plate.artworkCode,
          artworkVersion: plate.artworkVersion,
          cartonId: plate.cartonId,
          artworkId: plate.artworkId,
          customerId: plate.customerId,
          plateSize: plate.plateSize,
          numberOfColours: custodyMetrics.numberOfColours,
          totalPlates: custodyMetrics.totalPlates,
          newPlates: custodyMetrics.newPlates,
          oldPlates: custodyMetrics.oldPlates,
          colours: pulledForCustody as object[],
          status: 'READY_ON_FLOOR',
          hubCustodySource: 'rack',
          hubPreviousStatus: plate.status,
          jobCardId: reqRow.jobCardId ?? null,
          rackLocation: null,
          slotNumber: null,
          rackNumber: null,
          ups: plate.ups,
          lastStatusUpdatedAt: new Date(),
        },
      })

      const nextNeeded = needed.filter((item) => !wanted.has(normColourKey(item.name)))
      const fullyFulfilled = nextNeeded.length === 0

      await tx.plateRequirement.update({
        where: { id: requirementId },
        data: {
          coloursNeeded: nextNeeded as object[],
          numberOfColours: nextNeeded.length,
          newPlatesNeeded: nextNeeded.length,
          lastStatusUpdatedAt: new Date(),
          ...(fullyFulfilled
            ? {
                status: 'fulfilled_from_rack',
                triageChannel: null,
              }
            : {}),
        },
      })

      return { custodyPlateId: custodyPlate.id, fulfilled: fullyFulfilled }
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: requirementId,
      newValue: {
        takeFromStock: true,
        plateStoreId,
        colourNames,
        custodyPlateId: result.custodyPlateId,
        fulfilled: result.fulfilled,
      } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[plate-hub/take-from-stock]', e)
    if (e instanceof TakeStockHttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (/Unique constraint|unique constraint/i.test(msg)) {
      return NextResponse.json(
        { error: 'Failed to move inventory: duplicate plate code — retry in a moment.' },
        { status: 409 },
      )
    }
    if (/database is locked|SQLITE_BUSY/i.test(msg)) {
      return NextResponse.json({ error: 'Failed to move inventory: database busy — try again.' }, { status: 503 })
    }
    return NextResponse.json(
      { error: msg || 'Failed to move inventory. Try again or contact support.' },
      { status: 500 },
    )
  }
}
