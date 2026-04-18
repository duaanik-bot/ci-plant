import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

function esc(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

/** Post-production reconciliation: job cards × material batch usage (manual export). */
export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const cards = await db.productionJobCard.findMany({
    orderBy: { jobCardNumber: 'desc' },
    take: 10_000,
    select: {
      id: true,
      jobCardNumber: true,
      totalSheets: true,
      sheetsIssued: true,
      batchNumber: true,
      status: true,
      issuedStockDisplay: true,
      inventoryLocationPointer: true,
      grainFitStatus: true,
      allocatedPaperWarehouse: {
        select: {
          lotNumber: true,
          sheetSizeLabel: true,
          grainDirection: true,
          warehouseBayId: true,
          palletId: true,
        },
      },
      paperFloorIssues: {
        select: { qtySheets: true, createdAt: true, sourcePaperWarehouseId: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  const header = [
    'JobCard_ID',
    'JobCard_Number',
    'Status',
    'Total_Sheets_Job',
    'Sheets_Issued_Field',
    'Job_Batch_Number',
    'Allocated_Mill_Lot',
    'Inventory_Sheet_Size',
    'Inventory_Grain',
    'Warehouse_Bay',
    'Pallet_ID',
    'Sheets_Issued_To_Floor_Sum',
    'Floor_Issue_Count',
    'Issued_Stock_Display',
    'Location_Pointer',
    'Grain_Fit_Status',
  ]
  const lines = [header.join(',')]

  for (const c of cards) {
    const floorSum = c.paperFloorIssues.reduce((s, p) => s + p.qtySheets, 0)
    const wh = c.allocatedPaperWarehouse
    lines.push(
      [
        esc(c.id),
        esc(String(c.jobCardNumber)),
        esc(c.status),
        esc(String(c.totalSheets)),
        esc(String(c.sheetsIssued)),
        esc(c.batchNumber ?? ''),
        esc(wh?.lotNumber ?? ''),
        esc(wh?.sheetSizeLabel ?? ''),
        esc(wh?.grainDirection ?? ''),
        esc(wh?.warehouseBayId ?? ''),
        esc(wh?.palletId ?? ''),
        esc(String(floorSum)),
        esc(String(c.paperFloorIssues.length)),
        esc(c.issuedStockDisplay ?? ''),
        esc(c.inventoryLocationPointer ?? ''),
        esc(c.grainFitStatus),
      ].join(','),
    )
  }

  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv;charset=utf-8',
      'Content-Disposition': `attachment; filename="job-card-material-reconciliation-${stamp}.csv"`,
    },
  })
}
