import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const headers = [
    'PERSON',
    'Code No.',
    'FIRM',
    'DEPARTMENT',
    'TRANSACTION MODE',
    'BASE 2026',
    'PRESENT DAYS',
    'AB',
    'OT',
    'ADVANCE',
    'BANK NAME',
    'ACCOUNT NUMBER',
    'IFSC CODE',
  ]

  const sampleRows = [
    ['Rohit Kumar', 'CI101', 'COLOUR', 'PRINTING', 'Cash', 18000, 30, 0, 12, 1000, 'HDFC Bank', '1234567890', 'HDFC0001234'],
    ['Manpreet Singh', 'CI102', 'PUREFLIX', 'COATING', 'Darbi', 22000, 28, 2, 9, 0, 'SBI', '009988776655', 'SBIN0005678'],
  ]

  const csv = [headers.join(','), ...sampleRows.map((row) => row.join(','))].join('\n')

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="salary-import-template.csv"',
    },
  })
}
