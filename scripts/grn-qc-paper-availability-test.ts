/**
 * Single focused end-to-end test for the GRN + receipt + QC paper flow.
 *
 * Drives the real route handlers (not transaction replay) and asserts:
 *   1. POST /api/inventory/grn writes a PaperWarehouse batch row alongside
 *      the qtyQuarantine increment and grn_quarantine StockMovement.
 *   2. POST /api/procurement/vendor-pos/[id]/receipts increments
 *      Inventory.qtyQuarantine for each matching PO line (kg → sheets
 *      when the matched Inventory is sheet-unit) and writes a
 *      grn_quarantine StockMovement with refId=receiptId.
 *   3. PATCH …/receipts/[receiptId]/qc moves the accepted kg from
 *      qtyQuarantine to qtyAvailable using the same kg→sheets conversion
 *      and writes a qc_release StockMovement with refId=receiptId.
 *
 * Stubs next-auth.getServerSession before importing the route handlers.
 *
 * Run: npx tsx scripts/grn-qc-paper-availability-test.ts
 */

// Patch next-auth BEFORE any route module is loaded.
//
// `next-auth/index.js` exposes `getServerSession` via Object.defineProperty
// getters that delegate to `next-auth/next`, so assigning to the main
// package's exports has no effect. The inner `next-auth/next` module uses
// plain `exports.getServerSession = …`, which we can overwrite — and the
// main package's getter will then return our stub.
type StubSession = { user: { id: string; name: string; role: string } } | null
let __stubSession: StubSession = null

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextAuthNextMod = require('next-auth/next') as { getServerSession: unknown }
nextAuthNextMod.getServerSession = async () => __stubSession

import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'

async function main() {
  // Dynamically import the route modules AFTER the auth stub is installed.
  const grnRoute = await import('../src/app/api/inventory/grn/route')
  const receiptsRoute = await import('../src/app/api/procurement/vendor-pos/[id]/receipts/route')
  const qcRoute = await import(
    '../src/app/api/procurement/vendor-pos/[id]/receipts/[receiptId]/qc/route'
  )

  let failures = 0
  const expect = (name: string, cond: boolean, detail?: string) => {
    if (cond) console.log(`  ✓ ${name}`)
    else {
      failures++
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  const user = await db.user.findFirst({ where: { active: true } })
  if (!user) throw new Error('Need an active user in DB; run seed first.')

  const stamp = Date.now()
  const boardTypeLabel = `SBS-TEST-${stamp}`
  const grnRef = `TEST-GRN-${stamp}`

  // Realistic mill sheet dimensions in mm so the kg↔sheets math is sensible.
  // sheetWeightG = (700 × 1000 × 300) / 1e6 = 210 g/sheet
  // → 1000 kg ≈ round(1_000_000 / 210) = 4762 sheets
  const SHEET_LENGTH_MM = 700
  const SHEET_WIDTH_MM = 1000
  const GSM = 300
  const RECEIPT_KG = 1000
  const SHEET_WEIGHT_G = (SHEET_LENGTH_MM * SHEET_WIDTH_MM * GSM) / 1_000_000
  const EXPECTED_SHEETS_FROM_RECEIPT = Math.round((RECEIPT_KG * 1000) / SHEET_WEIGHT_G)

  const supplier = await db.supplier.create({
    data: { name: `TEST-SUP-${stamp}`, materialTypes: ['board'] },
  })

  const inv = await db.inventory.create({
    data: {
      materialCode: `TEST-PAPER-${stamp}`,
      description: 'Test SBS 300gsm 700×1000mm',
      boardType: boardTypeLabel,
      boardClassification: 'Art Folding',
      sheetLength: SHEET_LENGTH_MM,
      sheetWidth: SHEET_WIDTH_MM,
      gsm: GSM,
      unit: 'sheets',
      supplierId: supplier.id,
      qtyAvailable: 0,
      qtyQuarantine: 0,
      storageLocation: 'TEST-BAY',
      active: true,
    },
  })

  const vendorPo = await db.vendorMaterialPurchaseOrder.create({
    data: {
      poNumber: `TEST-VPO-${stamp}`,
      supplierId: supplier.id,
      // Must be a post-dispatch status for the receipts POST route to accept it.
      status: 'dispatched',
      createdBy: user.id,
    },
  })

  await db.vendorMaterialPurchaseOrderLine.create({
    data: {
      vendorPoId: vendorPo.id,
      boardGrade: boardTypeLabel,
      gsm: GSM,
      totalSheets: 5000,
      totalWeightKg: RECEIPT_KG,
      ratePerKg: 80,
      linkedPoLineIds: [],
    },
  })

  let pwId: string | null = null
  let receiptId: string | null = null

  try {
    // ── Phase 1: GRN POST ──
    __stubSession = { user: { id: user.id, name: user.name ?? 'Test', role: 'stores' } }

    const grnRes = await grnRoute.POST(
      new NextRequest('http://test/api/inventory/grn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          materialId: inv.id,
          qty: 5000,
          entryUnit: 'sheets',
          pricePerKg: 80,
          poReference: grnRef,
        }),
      }),
    )
    const grnBody = await grnRes.json()
    expect(
      'GRN POST succeeds (status 200, success=true)',
      grnRes.ok && grnBody.success === true,
      `status=${grnRes.status} body=${JSON.stringify(grnBody)}`,
    )

    const grnPw = await db.paperWarehouse.findFirst({
      where: { coaReference: grnRef },
    })
    expect('PaperWarehouse batch row created by local GRN', !!grnPw)
    if (grnPw) {
      pwId = grnPw.id
      expect('  qtySheets matches GRN qty', grnPw.qtySheets === 5000, `got ${grnPw.qtySheets}`)
      expect('  status = quarantine', grnPw.status === 'quarantine', `got ${grnPw.status}`)
      expect('  lotNumber set', !!grnPw.lotNumber)
      expect(
        '  rate captured from pricePerKg',
        grnPw.rate != null && Number(grnPw.rate) === 80,
        `got ${grnPw.rate}`,
      )
      expect(
        '  boardGrade from inv.boardClassification',
        grnPw.boardGrade === 'Art Folding',
        `got ${grnPw.boardGrade}`,
      )
      expect('  vendorId from inv.supplierId', grnPw.vendorId === supplier.id)
    }

    // ── Phase 2: Vendor receipt POST ──
    const invBeforeReceipt = await db.inventory.findUnique({ where: { id: inv.id } })
    const qBeforeReceipt = Number(invBeforeReceipt!.qtyQuarantine)

    const receiptRes = await receiptsRoute.POST(
      new NextRequest(`http://test/api/procurement/vendor-pos/${vendorPo.id}/receipts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          receiptDate: new Date().toISOString(),
          receivedQty: RECEIPT_KG,
          vehicleNumber: 'TEST-VEH',
          scaleSlipId: `TEST-SLIP-${stamp}`,
        }),
      }),
      { params: Promise.resolve({ id: vendorPo.id }) },
    )
    const receiptBody = await receiptRes.json()
    expect(
      'Receipt POST succeeds (status 200, ok=true)',
      receiptRes.ok && receiptBody.ok === true,
      `status=${receiptRes.status} body=${JSON.stringify(receiptBody)}`,
    )
    receiptId = receiptBody.receipt?.id ?? null
    expect('Receipt id returned', !!receiptId)

    const invAfterReceipt = await db.inventory.findUnique({ where: { id: inv.id } })
    const qAfterReceipt = Number(invAfterReceipt!.qtyQuarantine)
    expect(
      `Inventory.qtyQuarantine incremented by ${EXPECTED_SHEETS_FROM_RECEIPT} sheets (kg→sheets of ${RECEIPT_KG} kg)`,
      qAfterReceipt === qBeforeReceipt + EXPECTED_SHEETS_FROM_RECEIPT,
      `before=${qBeforeReceipt} after=${qAfterReceipt}`,
    )

    const receiptMovement = await db.stockMovement.findFirst({
      where: {
        materialId: inv.id,
        movementType: 'grn_quarantine',
        refType: 'vendor_receipt',
        refId: receiptId ?? '',
      },
    })
    expect(
      'grn_quarantine StockMovement linked to vendor receipt',
      !!receiptMovement,
    )
    if (receiptMovement) {
      expect(
        '  movement qty equals expected sheets',
        Number(receiptMovement.qty) === EXPECTED_SHEETS_FROM_RECEIPT,
        `got ${receiptMovement.qty}`,
      )
    }

    const receiptPw = await db.paperWarehouse.findFirst({
      where: { coaReference: receiptId ?? '' },
    })
    expect('PaperWarehouse batch row created by vendor receipt', !!receiptPw)
    if (receiptPw) {
      expect(
        '  qtySheets matches kg→sheets conversion',
        receiptPw.qtySheets === EXPECTED_SHEETS_FROM_RECEIPT,
        `got ${receiptPw.qtySheets}`,
      )
      expect('  status = quarantine on receipt', receiptPw.status === 'quarantine')
      expect(
        '  lotNumber from scaleSlipId',
        receiptPw.lotNumber === `TEST-SLIP-${stamp}`,
        `got ${receiptPw.lotNumber}`,
      )
      expect('  vendorId from PO supplier', receiptPw.vendorId === supplier.id)
    }

    // ── Phase 3: QC PATCH ──
    __stubSession = { user: { id: user.id, name: user.name ?? 'Test', role: 'qa_officer' } }

    const invBeforeQc = await db.inventory.findUnique({ where: { id: inv.id } })
    const qBeforeQc = Number(invBeforeQc!.qtyQuarantine)
    const aBeforeQc = Number(invBeforeQc!.qtyAvailable)

    const qcRes = await qcRoute.PATCH(
      new NextRequest(
        `http://test/api/procurement/vendor-pos/${vendorPo.id}/receipts/${receiptId}/qc`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            qcDetails: {
              qtyAcceptedStandard: RECEIPT_KG,
              qtyAcceptedPenalty: 0,
              qtyRejected: 0,
              actualGsm: GSM,
              shadeMatch: true,
              surfaceCleanliness: true,
              qcRemarks: 'Test QC accept (full)',
            },
          }),
        },
      ),
      { params: Promise.resolve({ id: vendorPo.id, receiptId: receiptId! }) },
    )
    const qcBody = await qcRes.json()
    expect(
      'QC PATCH succeeds (status 200, ok=true)',
      qcRes.ok && qcBody.ok === true,
      `status=${qcRes.status} body=${JSON.stringify(qcBody)}`,
    )

    const invAfterQc = await db.inventory.findUnique({ where: { id: inv.id } })
    const qAfterQc = Number(invAfterQc!.qtyQuarantine)
    const aAfterQc = Number(invAfterQc!.qtyAvailable)
    expect(
      `Inventory.qtyQuarantine decremented by ${EXPECTED_SHEETS_FROM_RECEIPT} sheets`,
      qAfterQc === qBeforeQc - EXPECTED_SHEETS_FROM_RECEIPT,
      `before=${qBeforeQc} after=${qAfterQc}`,
    )
    expect(
      `Inventory.qtyAvailable incremented by ${EXPECTED_SHEETS_FROM_RECEIPT} sheets`,
      aAfterQc === aBeforeQc + EXPECTED_SHEETS_FROM_RECEIPT,
      `before=${aBeforeQc} after=${aAfterQc}`,
    )
    expect(
      'Net quarantine returns to GRN-only level (receipt added = QC released)',
      qAfterQc === 5000,
      `expected 5000, got ${qAfterQc}`,
    )

    const release = await db.stockMovement.findFirst({
      where: {
        materialId: inv.id,
        movementType: 'qc_release',
        refType: 'vendor_receipt',
        refId: receiptId ?? '',
      },
    })
    expect('qc_release StockMovement created with refId=receiptId', !!release)
    if (release) {
      expect(
        '  movement qty equals expected sheets',
        Number(release.qty) === EXPECTED_SHEETS_FROM_RECEIPT,
        `got ${release.qty}`,
      )
    }

    const promotedPw = await db.paperWarehouse.findFirst({
      where: { coaReference: receiptId ?? '' },
    })
    expect(
      'Vendor PaperWarehouse row promoted to in_stock after QC',
      promotedPw != null && promotedPw.status === 'in_stock',
      `status=${promotedPw?.status ?? 'missing'}`,
    )
    if (promotedPw) {
      expect(
        '  qcResult = passed (full accept)',
        promotedPw.qcResult === 'passed',
        `got ${promotedPw.qcResult}`,
      )
      expect('  qcInspectedAt set', !!promotedPw.qcInspectedAt)
      expect('  qcInspectedBy set', !!promotedPw.qcInspectedBy)
      expect(
        '  measuredGsm matches actualGsm',
        promotedPw.measuredGsm === GSM,
        `got ${promotedPw.measuredGsm}`,
      )
      expect(
        '  qtySheets unchanged (no rejection)',
        promotedPw.qtySheets === EXPECTED_SHEETS_FROM_RECEIPT,
        `got ${promotedPw.qtySheets}`,
      )
    }
  } finally {
    // ── Cleanup ──
    await db.stockMovement.deleteMany({ where: { materialId: inv.id } })
    await db.paperWarehouse.deleteMany({ where: { paperType: boardTypeLabel } })
    void pwId
    await db.vendorMaterialReceipt.deleteMany({ where: { vendorPoId: vendorPo.id } })
    await db.vendorMaterialPurchaseOrderLine.deleteMany({ where: { vendorPoId: vendorPo.id } })
    await db.vendorMaterialPurchaseOrder.delete({ where: { id: vendorPo.id } })
    await db.inventory.delete({ where: { id: inv.id } })
    await db.supplier.delete({ where: { id: supplier.id } })
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\n✓ All assertions passed')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
