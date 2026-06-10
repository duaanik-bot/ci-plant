import { jsPDF } from 'jspdf'

export type ProcurementDocumentRow = {
  label: string
  value: string | number | null | undefined
}

export type ProcurementDocumentLine = Record<string, string | number | null | undefined>

export function buildProcurementDocumentPdf(input: {
  title: string
  documentNumber: string
  rows: ProcurementDocumentRow[]
  lines?: ProcurementDocumentLine[]
  remarks?: string | null
}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 14
  let y = margin
  doc.setFontSize(16)
  doc.text('Darbi Print Pack / Colour Impressions', margin, y)
  y += 8
  doc.setFontSize(11)
  doc.text(input.title, margin, y)
  y += 8
  doc.setFontSize(10)
  doc.text(`Document #: ${input.documentNumber}`, margin, y)
  y += 7

  for (const row of input.rows) {
    if (y > 270) {
      doc.addPage()
      y = margin
    }
    doc.text(`${row.label}: ${row.value ?? '-'}`, margin, y)
    y += 6
  }

  if (input.lines?.length) {
    y += 4
    doc.setFontSize(11)
    doc.text('Lines', margin, y)
    y += 6
    doc.setFontSize(9)
    for (const line of input.lines) {
      if (y > 270) {
        doc.addPage()
        y = margin
      }
      const text = Object.entries(line).map(([k, v]) => `${k}: ${v ?? '-'}`).join(' | ')
      doc.text(text.slice(0, 170), margin, y)
      y += 5
    }
  }

  if (input.remarks) {
    y += 5
    if (y > 270) {
      doc.addPage()
      y = margin
    }
    doc.setFontSize(10)
    doc.text(`Remarks: ${input.remarks}`, margin, y)
  }

  return Buffer.from(doc.output('arraybuffer'))
}

