import { db } from '@/lib/db'
import {
  CUSTODY_AT_VENDOR,
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_IN_STOCK,
  CUSTODY_ON_FLOOR,
} from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { createShadeCardEvent, SHADE_CARD_ACTION } from '@/lib/shade-card-events'
import { shadeCardIsExpired } from '@/lib/shade-card-age'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export type InventoryToolKind = 'die' | 'emboss_block' | 'shade_card'

export type IssueResult =
  | { ok: true }
  | {
      ok: false
      code:
        | 'NOT_FOUND'
        | 'BAD_MACHINE'
        | 'BAD_OPERATOR'
        | 'ALREADY_ISSUED'
        | 'INVALID_STATE'
        | 'NOT_ON_FLOOR'
        | 'NOT_AT_VENDOR'
      message: string
    }

export async function issueToolToMachine(
  kind: InventoryToolKind,
  toolId: string,
  machineId: string,
  operatorUserId: string | undefined,
  operatorNameText?: string | null,
): Promise<IssueResult> {
  if (!toolId?.trim() || !machineId?.trim()) {
    return { ok: false, code: 'INVALID_STATE', message: 'toolId and machineId are required' }
  }

  const machine = await db.machine.findUnique({ where: { id: machineId } })
  if (!machine) return { ok: false, code: 'BAD_MACHINE', message: 'Machine not found' }

  let operatorLabel: string
  let maintenancePerformedBy: string
  const trimmedName = operatorNameText?.trim()
  if (trimmedName) {
    operatorLabel = trimmedName
    maintenancePerformedBy = trimmedName
  } else if (operatorUserId?.trim()) {
    const operator = await db.user.findUnique({
      where: { id: operatorUserId },
      select: { id: true, name: true, active: true },
    })
    if (!operator || !operator.active) return { ok: false, code: 'BAD_OPERATOR', message: 'Operator not found' }
    operatorLabel = operator.name
    maintenancePerformedBy = operator.name
  } else {
    return { ok: false, code: 'BAD_OPERATOR', message: 'Operator is required' }
  }

  try {
    await db.$transaction(async (tx) => {
      if (kind === 'die') {
        const upd = await tx.dye.updateMany({
          where: {
            id: toolId,
            custodyStatus: { in: [CUSTODY_IN_STOCK, CUSTODY_HUB_CUSTODY_READY] },
            active: true,
          },
          data: {
            custodyStatus: CUSTODY_ON_FLOOR,
            issuedMachineId: machineId,
            issuedOperator: operatorLabel,
            issuedAt: new Date(),
          },
        })
        if (upd.count !== 1) {
          const row = await tx.dye.findUnique({ where: { id: toolId } })
          if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          if (row.custodyStatus === CUSTODY_ON_FLOOR) throw Object.assign(new Error('ALREADY_ISSUED'), { code: 'ALREADY_ISSUED' })
          throw Object.assign(new Error('INVALID_STATE'), { code: 'INVALID_STATE' })
        }
        await tx.dyeMaintenanceLog.create({
          data: {
            dyeId: toolId,
            actionType: 'issue_to_machine',
            performedBy: maintenancePerformedBy,
            notes: `Issued to machine ${machine.machineCode} (${machine.name})`,
          },
        })
        return
      }

      if (kind === 'emboss_block') {
        const upd = await tx.embossBlock.updateMany({
          where: {
            id: toolId,
            custodyStatus: { in: [CUSTODY_IN_STOCK, CUSTODY_HUB_CUSTODY_READY] },
            active: true,
          },
          data: {
            custodyStatus: CUSTODY_ON_FLOOR,
            issuedMachineId: machineId,
            issuedOperator: operatorLabel,
            issuedAt: new Date(),
          },
        })
        if (upd.count !== 1) {
          const row = await tx.embossBlock.findUnique({ where: { id: toolId } })
          if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          if (row.custodyStatus === CUSTODY_ON_FLOOR) throw Object.assign(new Error('ALREADY_ISSUED'), { code: 'ALREADY_ISSUED' })
          throw Object.assign(new Error('INVALID_STATE'), { code: 'INVALID_STATE' })
        }
        await tx.embossBlockMaintenanceLog.create({
          data: {
            blockId: toolId,
            actionType: 'issue_to_machine',
            performedBy: maintenancePerformedBy,
            notes: `Issued to machine ${machine.machineCode} (${machine.name})`,
          },
        })
        return
      }

      const row = await tx.shadeCard.findUnique({ where: { id: toolId } })
      if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
      if (shadeCardIsExpired(row.mfgDate)) {
        throw Object.assign(new Error('SHADE_EXPIRED'), { code: 'SHADE_EXPIRED' })
      }
      if (row.custodyStatus !== CUSTODY_IN_STOCK) {
        if (row.custodyStatus === CUSTODY_ON_FLOOR) {
          throw Object.assign(new Error('ALREADY_ISSUED'), { code: 'ALREADY_ISSUED' })
        }
        throw Object.assign(new Error('INVALID_STATE'), { code: 'INVALID_STATE' })
      }
      const upd = await tx.shadeCard.updateMany({
        where: { id: toolId, custodyStatus: CUSTODY_IN_STOCK },
        data: {
          custodyStatus: CUSTODY_ON_FLOOR,
          issuedMachineId: machineId,
          issuedOperator: operatorLabel,
          issuedAt: new Date(),
          currentHolder: `${machine.machineCode} · ${operatorLabel}`,
        },
      })
      if (upd.count !== 1) {
        throw Object.assign(new Error('INVALID_STATE'), { code: 'INVALID_STATE' })
      }
      await createShadeCardEvent(tx, {
        shadeCardId: toolId,
        actionType: SHADE_CARD_ACTION.ISSUED,
        details: {
          machineId,
          machineCode: machine.machineCode,
          machineName: machine.name,
          operatorName: operatorLabel,
        },
      })
    })
    return { ok: true }
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code
    if (code === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND', message: 'Tool not found' }
    if (code === 'ALREADY_ISSUED') {
      return { ok: false, code: 'ALREADY_ISSUED', message: 'Tool is already on the floor. Receive to rack first.' }
    }
    if (code === 'INVALID_STATE') {
      return { ok: false, code: 'INVALID_STATE', message: 'Tool cannot be issued in its current state' }
    }
    if (code === 'SHADE_EXPIRED') {
      return {
        ok: false,
        code: 'SHADE_EXPIRED',
        message: 'Shade card is EXPIRED (>12 months on 30.44-day basis). Replace before issuing to floor.',
      }
    }
    throw e
  }
}

export async function receiveToolFromFloor(
  kind: InventoryToolKind,
  toolId: string,
  finalImpressions: number,
  condition: 'Good' | 'Damaged' | 'Needs Repair',
): Promise<IssueResult> {
  if (!toolId?.trim()) {
    return { ok: false, code: 'INVALID_STATE', message: 'toolId is required' }
  }

  try {
    await db.$transaction(async (tx) => {
      if (kind === 'die') {
        const upd = await tx.dye.updateMany({
          where: { id: toolId, custodyStatus: CUSTODY_ON_FLOOR },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            impressionCount: { increment: finalImpressions },
            condition,
          },
        })
        if (upd.count !== 1) {
          const row = await tx.dye.findUnique({ where: { id: toolId } })
          if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          throw Object.assign(new Error('NOT_ON_FLOOR'), { code: 'NOT_ON_FLOOR' })
        }
        await tx.dyeMaintenanceLog.create({
          data: {
            dyeId: toolId,
            actionType: 'return_to_rack',
            performedBy: 'system',
            notes: `Returned from floor; +${finalImpressions} impressions; condition ${condition}`,
          },
        })
        return
      }

      if (kind === 'emboss_block') {
        const upd = await tx.embossBlock.updateMany({
          where: { id: toolId, custodyStatus: CUSTODY_ON_FLOOR },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            impressionCount: { increment: finalImpressions },
            condition,
          },
        })
        if (upd.count !== 1) {
          const row = await tx.embossBlock.findUnique({ where: { id: toolId } })
          if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          throw Object.assign(new Error('NOT_ON_FLOOR'), { code: 'NOT_ON_FLOOR' })
        }
        await tx.embossBlockMaintenanceLog.create({
          data: {
            blockId: toolId,
            actionType: 'return_to_rack',
            performedBy: 'system',
            notes: `Returned from floor; +${finalImpressions} impressions; condition ${condition}`,
          },
        })
        return
      }

      const upd = await tx.shadeCard.updateMany({
        where: { id: toolId, custodyStatus: CUSTODY_ON_FLOOR },
        data: {
          custodyStatus: CUSTODY_IN_STOCK,
          issuedMachineId: null,
          issuedOperator: null,
          issuedAt: null,
          impressionCount: { increment: finalImpressions },
          currentHolder: null,
        },
      })
      if (upd.count !== 1) {
        const row = await tx.shadeCard.findUnique({ where: { id: toolId } })
        if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
        throw Object.assign(new Error('NOT_ON_FLOOR'), { code: 'NOT_ON_FLOOR' })
      }
      await createShadeCardEvent(tx, {
        shadeCardId: toolId,
        actionType: SHADE_CARD_ACTION.RECEIVED,
        details: { finalImpressions, condition },
      })
    })
    return { ok: true }
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code
    if (code === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND', message: 'Tool not found' }
    if (code === 'NOT_ON_FLOOR') {
      return { ok: false, code: 'NOT_ON_FLOOR', message: 'Tool is not on the floor (nothing to receive).' }
    }
    throw e
  }
}

/** Move tool from vendor triage back to rack stock (in_stock). */
export async function receiveToolFromVendor(
  kind: InventoryToolKind,
  toolId: string,
  options?: { notes?: string | null; condition?: 'Good' | 'Damaged' | 'Needs Repair' },
): Promise<IssueResult> {
  if (!toolId?.trim()) {
    return { ok: false, code: 'INVALID_STATE', message: 'toolId is required' }
  }

  const noteSuffix = (options?.notes ?? '').trim()
  const logNotes = [noteSuffix ? noteSuffix : null, options?.condition ? `condition ${options.condition}` : null]
    .filter(Boolean)
    .join(' · ')

  try {
    await db.$transaction(async (tx) => {
      if (kind === 'die') {
        const row = await tx.dye.findFirst({
          where: { id: toolId, custodyStatus: CUSTODY_AT_VENDOR, active: true },
        })
        if (!row) {
          const any = await tx.dye.findUnique({ where: { id: toolId } })
          if (!any) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          throw Object.assign(new Error('NOT_AT_VENDOR'), { code: 'NOT_AT_VENDOR' })
        }
        const setDom = !row.dateOfManufacturing
        await tx.dye.update({
          where: { id: toolId },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            ...(setDom ? { dateOfManufacturing: new Date() } : {}),
            ...(options?.condition ? { condition: options.condition } : {}),
          },
        })
        if (setDom) {
          await createDieHubEvent(tx, {
            dyeId: toolId,
            actionType: DIE_HUB_ACTION.MANUFACTURED_AND_RECEIVED,
            fromZone: dieHubZoneLabelFromCustody(CUSTODY_AT_VENDOR),
            toZone: dieHubZoneLabelFromCustody(CUSTODY_IN_STOCK),
            actorName: 'Vendor receive',
            details: {
              message: 'Die manufactured and received from vendor.',
              displayCode: `DYE-${row.dyeNumber}`,
            },
          })
        }
        await tx.dyeMaintenanceLog.create({
          data: {
            dyeId: toolId,
            actionType: 'receive_from_vendor',
            performedBy: 'system',
            notes: logNotes ? `Received from vendor. ${logNotes}` : 'Received from vendor.',
          },
        })
        return
      }

      if (kind === 'emboss_block') {
        const upd = await tx.embossBlock.updateMany({
          where: { id: toolId, custodyStatus: CUSTODY_AT_VENDOR, active: true },
          data: {
            custodyStatus: CUSTODY_IN_STOCK,
            issuedMachineId: null,
            issuedOperator: null,
            issuedAt: null,
            ...(options?.condition ? { condition: options.condition } : {}),
          },
        })
        if (upd.count !== 1) {
          const row = await tx.embossBlock.findUnique({ where: { id: toolId } })
          if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          throw Object.assign(new Error('NOT_AT_VENDOR'), { code: 'NOT_AT_VENDOR' })
        }
        await tx.embossBlockMaintenanceLog.create({
          data: {
            blockId: toolId,
            actionType: 'receive_from_vendor',
            performedBy: 'system',
            notes: logNotes ? `Received from vendor. ${logNotes}` : 'Received from vendor.',
          },
        })
        return
      }

      const upd = await tx.shadeCard.updateMany({
        where: { id: toolId, custodyStatus: CUSTODY_AT_VENDOR },
        data: {
          custodyStatus: CUSTODY_IN_STOCK,
          issuedMachineId: null,
          issuedOperator: null,
          issuedAt: null,
          currentHolder: null,
        },
      })
      if (upd.count !== 1) {
        const row = await tx.shadeCard.findUnique({ where: { id: toolId } })
        if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
        throw Object.assign(new Error('NOT_AT_VENDOR'), { code: 'NOT_AT_VENDOR' })
      }
      await createShadeCardEvent(tx, {
        shadeCardId: toolId,
        actionType: SHADE_CARD_ACTION.VENDOR_RECEIVED,
        details: { notes: noteSuffix || null, condition: options?.condition ?? null },
      })
    })
    return { ok: true }
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code
    if (code === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND', message: 'Tool not found' }
    if (code === 'NOT_AT_VENDOR') {
      return { ok: false, code: 'NOT_AT_VENDOR', message: 'Tool is not at vendor (nothing to receive from vendor).' }
    }
    throw e
  }
}
