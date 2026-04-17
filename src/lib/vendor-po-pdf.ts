import { jsPDF } from 'jspdf'

export type VendorPoPdfLine = {
  boardGrade: string
  gsm: number
  grainDirection: string
  totalSheets: number
  totalWeightKg: number
  ratePerKg: number | null
}

export function buildVendorMaterialPoPdfBuffer(params: {
  poNumber: string
  supplierName: string
  signatoryName: string
  requiredDeliveryYmd: string | null
  remarks: string | null
  lines: VendorPoPdfLine[]
}): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 14
  let y = margin

  doc.setFontSize(16)
  doc.text('Darbi Print Pack / Colour Impressions', margin, y)
  y += 8
  doc.setFontSize(11)
  doc.text('Vendor material purchase order', margin, y)
  y += 7

  doc.setFontSize(10)
  doc.text(`PO #: ${params.poNumber}`, margin, y)
  y += 5
  doc.text(`Supplier: ${params.supplierName}`, margin, y)
  y += 5
  doc.text(`Signatory: ${params.signatoryName}`, margin, y)
  y += 5
  doc.text(
    `Required delivery: ${params.requiredDeliveryYmd ?? 'TBD'}`,
    margin,
    y,
  )
  y += 8

  doc.setFontSize(9)
  doc.text('Lines', margin, y)
  y += 5

  for (const ln of params.lines) {
    if (y > 270) {
      doc.addPage()
      y = margin
    }
    const rate = ln.ratePerKg != null ? `₹${ln.ratePerKg}/kg` : 'Rate TBD'
    doc.text(
      `${ln.boardGrade} · ${ln.gsm} GSM · ${ln.grainDirection} — Sheets: ${ln.totalSheets.toLocaleString('en-IN')} — Weight: ${ln.totalWeightKg.toFixed(3)} kg — ${rate}`,
      margin,
      y,
    )
    y += 5
  }

  if (params.remarks?.trim()) {
    y += 4
    doc.text(`Remarks: ${params.remarks.trim()}`, margin, y)
  }

  y += 10
  doc.setFontSize(8)
  doc.setTextColor(100)
  doc.text(
    'This document was generated electronically for procurement dispatch.',
    margin,
    y,
  )

  return Buffer.from(doc.output('arraybuffer'))
}
