import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { buildPoNumber, createPurchaseOrderWithLines } from '@/lib/po-create'
import { normalizeCartonSizeString, parseFinishedDims } from '@/lib/die-hub-dimensions'
import { syncMaterialRequirementsForPurchaseOrder } from '@/lib/material-requirement-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Matches the extract-route sentinel — must stay in sync. */
const NEW_CUSTOMER_SENTINEL = '__new__'

const newCartonSchema = z.object({
  /** Stable key the line items reference; not stored. */
  clientKey: z.string().min(1),
  cartonName: z.string().min(1),
  cartonSize: z.string().optional().nullable(),
  gsm: z.number().int().positive().optional().nullable(),
  rate: z.number().nonnegative().optional().nullable(),
  gstPct: z.number().int().min(0).max(28).default(12),
  artworkCode: z.string().optional().nullable(),
})

const lineSchema = z.object({
  /**
   * EITHER an existing Carton id OR a clientKey from newCartons[]. The route
   * resolves clientKey → newly-created Carton id inside the transaction.
   * Not strictly UUID — legacy seed cartons may exist with non-UUID ids.
   */
  cartonId: z.string().min(1).nullable().optional(),
  newCartonClientKey: z.string().optional().nullable(),
  cartonName: z.string().min(1),
  cartonSize: z.string().optional().nullable(),
  quantity: z.number().int().positive(),
  artworkCode: z.string().optional().nullable(),
  rate: z.number().nonnegative().optional().nullable(),
  gsm: z.number().int().positive().optional().nullable(),
  gstPct: z.number().int().min(0).max(28).default(12),
  remarks: z.string().optional().nullable(),
})

const newCustomerSchema = z.object({
  name: z.string().min(1).max(200),
  gstNumber: z.string().trim().max(32).optional().nullable(),
  address: z.string().trim().optional().nullable(),
})

const commitSchema = z.object({
  // Not strict UUID — legacy seed customers (e.g. 'sample-customer-001',
  // 'seed-customer-drreddy') predate the uuid default and still need to commit.
  // Also accepts the new-customer sentinel; the route then requires `newCustomer`.
  customerId: z.string().min(1),
  /** When customerId === NEW_CUSTOMER_SENTINEL, this carries the proposed buyer
   *  details from the PDF for in-transaction Customer.create. */
  newCustomer: newCustomerSchema.optional().nullable(),
  poNumber: z.string().min(1).max(100).optional().nullable(),
  poDate: z.string().min(1),
  deliveryRequiredBy: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  newCartons: z.array(newCartonSchema).default([]),
  lineItems: z.array(lineSchema).min(1),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const parsed = commitSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    console.error('[POST /api/purchase-orders/import/commit] Validation failed:', {
      fields,
      issues: parsed.error.issues,
      customerId: body?.customerId,
      customerIdType: typeof body?.customerId,
      customerIdLength: typeof body?.customerId === 'string' ? body.customerId.length : null,
      newCartonsSample: body?.newCartons?.[0],
      lineItemSample: body?.lineItems?.[0],
    })
    // Surface the first failing path/message in the human error so the toast
    // shows the actual problem ("lineItems.0.gsm: Expected number, received null")
    // instead of a generic "Validation failed".
    const firstPath = parsed.error.issues[0]?.path.join('.') ?? ''
    const firstMsg = parsed.error.issues[0]?.message ?? ''
    return NextResponse.json(
      {
        error: firstPath ? `${firstPath}: ${firstMsg}` : 'Validation failed',
        fields,
      },
      { status: 400 },
    )
  }

  const data = parsed.data

  const isNewCustomerFlow = data.customerId === NEW_CUSTOMER_SENTINEL
  if (isNewCustomerFlow && !data.newCustomer?.name?.trim()) {
    return NextResponse.json(
      {
        error: 'newCustomer.name is required when customerId is the new-customer sentinel.',
      },
      { status: 400 },
    )
  }
  if (!isNewCustomerFlow) {
    const customer = await db.customer.findUnique({
      where: { id: data.customerId },
      select: { id: true },
    })
    if (!customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }
  }

  // Resolve PO number — manual override if provided, else auto-generate.
  const rawPoNumber = data.poNumber?.trim()
  let poNumber: string
  if (rawPoNumber) {
    const existing = await db.purchaseOrder.findUnique({
      where: { poNumber: rawPoNumber },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'PO number already exists', fields: { poNumber: 'This PO number is already in use' } },
        { status: 400 },
      )
    }
    poNumber = rawPoNumber
  } else {
    const lastPo = await db.purchaseOrder.findFirst({
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    })
    poNumber = buildPoNumber(lastPo?.poNumber ?? null)
  }

  // Validate every line either has a real cartonId or a known clientKey.
  const newCartonKeys = new Set(data.newCartons.map((c) => c.clientKey))
  const referencedExistingIds = data.lineItems
    .map((l) => l.cartonId)
    .filter((id): id is string => Boolean(id))
  const existingValid = referencedExistingIds.length
    ? new Set(
        (
          await db.carton.findMany({
            where: { id: { in: referencedExistingIds }, customerId: data.customerId },
            select: { id: true },
          })
        ).map((c) => c.id),
      )
    : new Set<string>()

  for (const li of data.lineItems) {
    const hasExisting = li.cartonId && existingValid.has(li.cartonId)
    const hasNew = li.newCartonClientKey && newCartonKeys.has(li.newCartonClientKey)
    if (!hasExisting && !hasNew) {
      return NextResponse.json(
        {
          error:
            'Every line item must reference an existing Carton or a new-Carton clientKey from newCartons[].',
        },
        { status: 400 },
      )
    }
  }

  let created
  try {
    created = await db.$transaction(
      async (tx) => {
        // 0. If we're confirming-and-creating a customer from the PDF, do that
        //    first so cartons + PO can FK to a real id. Otherwise reuse the
        //    operator-provided / detected id directly.
        let resolvedCustomerId: string
        if (isNewCustomerFlow && data.newCustomer) {
          const createdCustomer = await tx.customer.create({
            data: {
              name: data.newCustomer.name.trim(),
              gstNumber: data.newCustomer.gstNumber?.trim() || null,
              address: data.newCustomer.address?.trim() || null,
              active: true,
              source: 'po_import_ai',
            },
            select: { id: true },
          })
          resolvedCustomerId = createdCustomer.id
        } else {
          resolvedCustomerId = data.customerId
        }

        // 1. Create any new Cartons proposed by the import in parallel — each
        //    proposal is independent. Sequential awaits over Neon round-trips
        //    were eating the 5 s interactive-transaction budget for POs with
        //    several new cartons.
        const cartonResults = await Promise.all(
          data.newCartons.map(async (proposal) => {
            const normalizedSize = normalizeCartonSizeString(proposal.cartonSize)
            const dims = parseFinishedDims(normalizedSize)
            const c = await tx.carton.create({
              data: {
                cartonName: proposal.cartonName,
                customerId: resolvedCustomerId,
                gsm: proposal.gsm ?? null,
                rate: proposal.rate ?? null,
                gstPct: proposal.gstPct,
                artworkCode: proposal.artworkCode ?? null,
                finishedLength: dims?.l ?? null,
                finishedWidth: dims?.w ?? null,
                finishedHeight: dims?.h ?? null,
                source: 'po_import_ai',
              },
              select: { id: true },
            })
            return { clientKey: proposal.clientKey, id: c.id }
          }),
        )
        const clientKeyToId = new Map(cartonResults.map((r) => [r.clientKey, r.id]))

        // 2. Build the line-items payload with resolved Carton ids.
        const resolvedLines = data.lineItems.map((li) => {
          const cartonId =
            (li.cartonId && existingValid.has(li.cartonId) ? li.cartonId : null) ||
            (li.newCartonClientKey ? clientKeyToId.get(li.newCartonClientKey) ?? null : null)
          return {
            cartonId,
            cartonName: li.cartonName,
            cartonSize: normalizeCartonSizeString(li.cartonSize),
            quantity: li.quantity,
            artworkCode: li.artworkCode ?? null,
            rate: li.rate ?? null,
            gsm: li.gsm ?? null,
            gstPct: li.gstPct,
            remarks: li.remarks ?? null,
          }
        })

        // 3. Create PO + line items inside the transaction. Skip the material
        //    sync — we run it post-commit since it's idempotent recompute work
        //    and was a major contributor to transaction timeouts.
        return await createPurchaseOrderWithLines(tx, {
          poNumber,
          customerId: resolvedCustomerId,
          poDate: new Date(data.poDate),
          deliveryRequiredBy: data.deliveryRequiredBy?.trim()
            ? new Date(data.deliveryRequiredBy.trim())
            : null,
          remarks: data.remarks ?? null,
          status: 'draft',
          isPriority: false,
          createdBy: user.id,
          lineItems: resolvedLines,
          skipMaterialSync: true,
        })
      },
      {
        // Neon round-trips + per-line material-MRP work occasionally pushed the
        // 5 s default over the cliff. 30 s is comfortably above worst-case
        // observed (~7 s for 10 lines) without masking a real regression.
        maxWait: 10_000,
        timeout: 30_000,
      },
    )
  } catch (err) {
    console.error('[POST /api/purchase-orders/import/commit] DB error:', err)
    const message = err instanceof Error ? err.message : 'Database error while saving PO'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Recompute MaterialQueue rows AFTER the PO transaction commits. Idempotent
  // — safe to re-run if it fails. Errors here log but don't fail the import,
  // since the PO + cartons are already saved and the user can re-trigger sync
  // from the PO detail view.
  try {
    await syncMaterialRequirementsForPurchaseOrder(created.id)
  } catch (err) {
    console.error(
      '[POST /api/purchase-orders/import/commit] Post-commit material sync failed (non-fatal):',
      err,
    )
  }

  await createAuditLog({
    userId: user.id,
    action: 'INSERT',
    tableName: 'purchase_orders',
    recordId: created.id,
    newValue: {
      poNumber,
      customerId: created.customerId,
      source: 'pdf_import',
      actorLabel: 'Anik Dua',
    },
  })

  return NextResponse.json({ id: created.id, poNumber: created.poNumber }, { status: 201 })
}
