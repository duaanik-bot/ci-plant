import type { Prisma, PurchaseOrder, Carton } from '@prisma/client'
import { syncMaterialRequirementsForPurchaseOrder } from '@/lib/material-requirement-sync'
import { withDefaultPrePressAuditLead } from '@/lib/pre-press-defaults'
import { buildCartonSpecPack } from '@/lib/carton-spec-pack'

type Tx = Prisma.TransactionClient

export type CreatePoLineInput = {
  cartonId: string | null
  cartonName: string
  cartonSize?: string | null
  quantity: number
  artworkCode?: string | null
  backPrint?: string | null
  rate?: number | Prisma.Decimal | null
  gsm?: number | null
  gstPct: number
  /// HSN snapshot — when omitted and `cartonId` is set, copied from Carton.hsnCode at write time.
  hsnCode?: string | null
  coatingType?: string | null
  otherCoating?: string | null
  embossingLeafing?: string | null
  paperType?: string | null
  dyeId?: string | null
  remarks?: string | null
  setNumber?: string | null
  dieMasterId?: string | null
  toolingLocked?: boolean
  lineDieType?: string | null
  dimLengthMm?: number | Prisma.Decimal | null
  dimWidthMm?: number | Prisma.Decimal | null
  dimHeightMm?: number | Prisma.Decimal | null
  specOverrides?: Record<string, unknown> | null
}

export type CreatePoInput = {
  poNumber: string
  customerId: string
  poDate: Date
  deliveryRequiredBy?: Date | null
  remarks?: string | null
  status?: string
  isPriority?: boolean
  createdBy: string
  lineItems: CreatePoLineInput[]
  /**
   * When true, skip the in-transaction `syncMaterialRequirementsForPurchaseOrder`
   * pass. Callers that pass true MUST run the sync themselves after the
   * transaction commits — the function is idempotent recompute work, so moving
   * it outside the transaction is safe and avoids the 5 s interactive-transaction
   * timeout when many lines are involved.
   */
  skipMaterialSync?: boolean
}

/** Generate the next PO number in the `CI-PO-YYYY-NNNN` series. */
export function buildPoNumber(existingMax: string | null): string {
  const year = new Date().getFullYear()
  const prefix = `CI-PO-${year}-`
  if (!existingMax || !existingMax.startsWith(prefix)) {
    return `${prefix}0001`
  }
  const lastSeq = parseInt(existingMax.replace(prefix, ''), 10) || 0
  const nextSeq = String(lastSeq + 1).padStart(4, '0')
  return `${prefix}${nextSeq}`
}

/**
 * Shared transaction body that creates a PurchaseOrder + its line items and
 * runs the material-requirement sync. Called by both the manual create route
 * and the PDF-import commit route so both paths produce identical downstream
 * state (material queues, audit-ready spec overrides, etc.).
 */
export async function createPurchaseOrderWithLines(
  tx: Tx,
  input: CreatePoInput,
): Promise<PurchaseOrder> {
  const po = await tx.purchaseOrder.create({
    data: {
      poNumber: input.poNumber,
      customerId: input.customerId,
      poDate: input.poDate,
      deliveryRequiredBy: input.deliveryRequiredBy ?? null,
      remarks: input.remarks ?? null,
      status: input.status || 'draft',
      isPriority: input.isPriority === true,
      createdBy: input.createdBy,
    },
  })

  // Fetch full carton rows for all lines that reference a carton. Used for both
  // HSN backfill (locks the HSN against the order's lifetime even if the Carton
  // master is edited later) and the spec-pack snapshot. Batched in a single query.
  const lineCartonIds = Array.from(
    new Set(
      input.lineItems
        .filter((li) => li.cartonId)
        .map((li) => li.cartonId as string),
    ),
  )
  const cartonById = new Map<string, Carton>()
  if (lineCartonIds.length > 0) {
    const rows = await tx.carton.findMany({ where: { id: { in: lineCartonIds } } })
    for (const r of rows) cartonById.set(r.id, r)
  }

  await Promise.all(
    input.lineItems.map((li) => {
      const cartonRow = li.cartonId ? cartonById.get(li.cartonId) ?? null : null
      const resolvedHsn =
        li.hsnCode != null && li.hsnCode !== ''
          ? li.hsnCode
          : cartonRow?.hsnCode ?? null
      return tx.poLineItem.create({
        data: {
          poId: po.id,
          cartonId: li.cartonId,
          cartonName: li.cartonName,
          cartonSize: li.cartonSize || null,
          quantity: li.quantity,
          artworkCode: li.artworkCode || null,
          backPrint: li.backPrint || 'No',
          rate: li.rate ?? null,
          gsm: li.gsm ?? null,
          gstPct: li.gstPct,
          hsnCode: resolvedHsn,
          coatingType: li.coatingType || null,
          otherCoating: li.otherCoating || null,
          embossingLeafing: li.embossingLeafing || null,
          paperType: li.paperType || null,
          dyeId: li.dyeId || null,
          remarks: li.remarks || null,
          setNumber: li.setNumber || null,
          dieMasterId: li.dieMasterId || null,
          toolingLocked: li.toolingLocked ?? true,
          lineDieType: li.lineDieType || null,
          dimLengthMm: li.dimLengthMm ?? null,
          dimWidthMm: li.dimWidthMm ?? null,
          dimHeightMm: li.dimHeightMm ?? null,
          specOverrides: withDefaultPrePressAuditLead(
            li.specOverrides && Object.keys(li.specOverrides).length > 0
              ? li.specOverrides
              : null,
          ) as object,
          specPack: cartonRow ? (buildCartonSpecPack(cartonRow) as object) : undefined,
        },
      })
    }),
  )

  if (!input.skipMaterialSync) {
    await syncMaterialRequirementsForPurchaseOrder(po.id, tx)
  }

  return po
}
