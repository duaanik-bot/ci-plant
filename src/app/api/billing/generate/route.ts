import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  computeInvoiceTotals,
  financialYearStringFor,
  isEwayApplicable,
  nextInvoiceNumberForFy,
  resolveTaxSplit,
  type LineForInvoice,
} from '@/lib/indian-gst'
import { COMPANY } from '@/lib/company-config'

export const dynamic = 'force-dynamic'

const DISPATCH_TAG = 'dispatch-queue'
const BILLING_TAG = 'billing-queue'
const BILLS_TAG = 'bills'

const schema = z.object({
  dispatchIds: z.array(z.string().uuid()).min(1),
  billDate: z.string().optional(), // ISO date; defaults to today
  /// When provided, overrides the customer's stored state code (e.g. drop-ship to a different state).
  placeOfSupplyStateCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/)
    .optional(),
  /// Optional rate override per dispatch — when the operator wants to invoice at a different price than PO rate.
  rateOverrides: z.record(z.string().uuid(), z.number().nonnegative()).optional(),
})

/**
 * Invoice engine: consolidate selected dispatches into a single Tally-style tax invoice.
 *
 * Pre-conditions enforced:
 * - All dispatches must belong to the same customer.
 * - All dispatches must be in `billing_status='sent_to_billing'`.
 * - Each dispatch must have a poLineItem (anchors the rate + HSN).
 *
 * Output:
 * - New Bill with FY-numbered Tally id (`CI/26-27/0001`).
 * - One BillLineItem per dispatch (no merging within the same customer in this cycle).
 * - Dispatches updated: billing_status='billed', bill_id=newBill.id.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { dispatchIds, billDate: billDateInput, placeOfSupplyStateCode, rateOverrides } =
    parsed.data

  // Fetch dispatches with everything needed for invoice math.
  const dispatches = await db.dispatch.findMany({
    where: { id: { in: dispatchIds } },
    include: {
      jobCard: {
        select: {
          id: true,
          jobCardNumber: true,
          setNumber: true,
          customerId: true,
          customer: {
            select: {
              id: true,
              name: true,
              stateCode: true,
              gstNumber: true,
              billingAddress: true,
              shippingAddress: true,
              address: true,
            },
          },
        },
      },
      poLineItem: {
        select: {
          id: true,
          cartonName: true,
          rate: true,
          gstPct: true,
          hsnCode: true,
          po: { select: { poNumber: true } },
        },
      },
    },
  })

  if (dispatches.length !== dispatchIds.length) {
    return NextResponse.json(
      { error: 'One or more dispatch IDs not found' },
      { status: 404 },
    )
  }

  // Same-customer guard.
  const customerIds = Array.from(new Set(dispatches.map((d) => d.jobCard?.customerId).filter(Boolean)))
  if (customerIds.length !== 1) {
    return NextResponse.json(
      { error: 'All selected dispatches must belong to the same customer.' },
      { status: 400 },
    )
  }

  // sent_to_billing guard.
  const notReady = dispatches.filter((d) => d.billingStatus !== 'sent_to_billing')
  if (notReady.length > 0) {
    return NextResponse.json(
      {
        error: 'Some dispatches are not in Send-to-Billing state.',
        notReadyIds: notReady.map((d) => d.id),
      },
      { status: 409 },
    )
  }

  // poLineItem required for rate + GST.
  const missingPo = dispatches.filter((d) => !d.poLineItem)
  if (missingPo.length > 0) {
    return NextResponse.json(
      {
        error: 'Some dispatches have no PO line item linked — cannot price the invoice.',
        missingIds: missingPo.map((d) => d.id),
      },
      { status: 400 },
    )
  }

  const customer = dispatches[0].jobCard!.customer
  const sellerState = COMPANY.stateCode
  const buyerState = placeOfSupplyStateCode ?? customer.stateCode ?? sellerState
  const taxSplit = resolveTaxSplit(buyerState, sellerState)

  // Build invoice lines from the dispatches.
  const lines: LineForInvoice[] = dispatches.map((d) => {
    const poLine = d.poLineItem!
    const rateOverride = rateOverrides?.[d.id]
    const rate = rateOverride != null ? rateOverride : Number(poLine.rate ?? 0)
    return {
      description: `${poLine.cartonName}${poLine.po?.poNumber ? ` · PO ${poLine.po.poNumber}` : ''}`,
      hsnCode: poLine.hsnCode,
      quantity: d.qtyDispatched,
      rate,
      gstPct: poLine.gstPct,
      dispatchId: d.id,
      jobCardId: d.jobCard?.id ?? null,
    }
  })

  const totals = computeInvoiceTotals(lines, taxSplit)

  // FY numbering — find the highest existing seq for this FY.
  const billDate = billDateInput ? new Date(billDateInput) : new Date()
  const fy = financialYearStringFor(billDate)
  const lastForFy = await db.bill.findFirst({
    where: { financialYear: fy },
    orderBy: { createdAt: 'desc' },
    select: { billNumber: true },
  })
  const lastSeq = lastForFy
    ? (lastForFy.billNumber.match(/\/(\d+)$/)?.[1] ? Number(lastForFy.billNumber.match(/\/(\d+)$/)![1]) : 0)
    : 0
  const billNumber = nextInvoiceNumberForFy(fy, lastSeq)

  // E-way applicability: invoice value + at least one dispatch has a transport mode.
  const ewayApplicable = isEwayApplicable({
    invoiceValue: totals.totalAmount,
    transportMode: dispatches[0].transportMode ?? null,
  })

  // HSN summary in DB-friendly JSON.
  const hsnSummaryJson = totals.hsnSummary as unknown as Prisma.InputJsonValue

  const created = await db.$transaction(async (tx) => {
    const bill = await tx.bill.create({
      data: {
        billNumber,
        financialYear: fy,
        customerId: customer.id,
        billDate,
        placeOfSupplyStateCode: buyerState,
        taxSplit,
        subtotal: new Prisma.Decimal(totals.subtotal),
        cgstAmount: new Prisma.Decimal(totals.cgstAmount),
        sgstAmount: new Prisma.Decimal(totals.sgstAmount),
        igstAmount: new Prisma.Decimal(totals.igstAmount),
        gstAmount: new Prisma.Decimal(totals.gstAmount),
        totalAmount: new Prisma.Decimal(totals.totalAmount),
        hsnSummary: hsnSummaryJson,
        transportMode: dispatches[0].transportMode ?? null,
        transporterName: dispatches[0].transporterName ?? null,
        vehicleNumber: dispatches[0].vehicleNumber ?? null,
        distanceKm: dispatches[0].distanceKm ?? null,
        ewayBillNumber: dispatches[0].ewayBillNumber ?? null,
        ewayBillExpiry: dispatches[0].ewayBillExpiry ?? null,
        ewayApplicable,
        status: 'draft',
        createdBy: user!.id,
      },
    })

    await tx.billLineItem.createMany({
      data: totals.lines.map((l) => ({
        billId: bill.id,
        jobCardId: l.jobCardId ?? null,
        dispatchId: l.dispatchId ?? null,
        description: l.description,
        hsnCode: l.hsnCode,
        quantity: l.quantity,
        rate: new Prisma.Decimal(l.rate),
        gstPct: l.gstPct,
        taxableAmount: new Prisma.Decimal(l.taxableAmount),
        cgstAmount: new Prisma.Decimal(l.cgstAmount),
        sgstAmount: new Prisma.Decimal(l.sgstAmount),
        igstAmount: new Prisma.Decimal(l.igstAmount),
        amount: new Prisma.Decimal(l.totalAmount),
      })),
    })

    await tx.dispatch.updateMany({
      where: { id: { in: dispatchIds } },
      data: { billingStatus: 'billed', billId: bill.id },
    })

    return bill
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'bills',
    recordId: created.id,
    newValue: {
      billNumber,
      fy,
      dispatchIds,
      taxSplit,
      subtotal: totals.subtotal,
      gstAmount: totals.gstAmount,
      totalAmount: totals.totalAmount,
      ewayApplicable,
    },
  })

  revalidateTag(DISPATCH_TAG)
  revalidateTag(BILLING_TAG)
  revalidateTag(BILLS_TAG)

  return NextResponse.json(
    {
      id: created.id,
      billNumber,
      financialYear: fy,
      taxSplit,
      subtotal: totals.subtotal,
      cgstAmount: totals.cgstAmount,
      sgstAmount: totals.sgstAmount,
      igstAmount: totals.igstAmount,
      gstAmount: totals.gstAmount,
      totalAmount: totals.totalAmount,
      ewayApplicable,
      lineCount: totals.lines.length,
      hsnSummary: totals.hsnSummary,
    },
    { status: 201 },
  )
}
