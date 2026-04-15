import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

export function sanitizeFileBase(name: string): string {
  const s = name
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80)
  return s || 'export'
}

export type ExportMatrix = { headers: string[]; rows: string[][] }

export function buildExportMatrix<T>(
  columns: { header: string; getValue: (row: T) => string }[],
  data: T[],
): ExportMatrix {
  return {
    headers: columns.map((c) => c.header),
    rows: data.map((row) => columns.map((c) => c.getValue(row))),
  }
}

export function downloadLedgerXlsx(opts: {
  fileBase: string
  sheetName: string
  title: string
  filterSummary?: string[]
  matrix: ExportMatrix
}): void {
  const generated = new Date().toLocaleString()
  const meta: string[][] = [
    [opts.title],
    [`Generated: ${generated}`],
    ...(opts.filterSummary?.length ? [[`Filters: ${opts.filterSummary.join(' · ')}`]] : []),
    [],
    opts.matrix.headers,
    ...opts.matrix.rows,
  ]
  const ws = XLSX.utils.aoa_to_sheet(meta)
  const wb = XLSX.utils.book_new()
  const sn = opts.sheetName.replace(/[*?:/\\[\]]/g, '').slice(0, 31) || 'Sheet1'
  XLSX.utils.book_append_sheet(wb, ws, sn)
  XLSX.writeFile(wb, `${sanitizeFileBase(opts.fileBase)}.xlsx`)
}

export function downloadLedgerPdf(opts: {
  fileBase: string
  title: string
  filterSummary?: string[]
  matrix: ExportMatrix
}): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  let y = 14
  doc.setFontSize(14)
  doc.text(opts.title, 14, y)
  y += 7
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, y)
  y += 5
  if (opts.filterSummary?.length) {
    const filterText = `Filters: ${opts.filterSummary.join(' · ')}`
    const lines = doc.splitTextToSize(filterText, 260)
    doc.text(lines, 14, y)
    y += Math.max(5, lines.length * 4.5)
  }
  doc.setTextColor(0)
  autoTable(doc, {
    startY: y + 2,
    head: [opts.matrix.headers],
    body: opts.matrix.rows,
    styles: { fontSize: 8, cellPadding: 1.5, lineColor: [220, 220, 220], lineWidth: 0.1 },
    headStyles: { fillColor: [24, 24, 27], textColor: 255, fontStyle: 'bold', halign: 'left' },
    alternateRowStyles: { fillColor: [252, 252, 252] },
    margin: { left: 14, right: 14 },
    tableLineColor: [200, 200, 200],
    tableLineWidth: 0.1,
  })
  doc.save(`${sanitizeFileBase(opts.fileBase)}.pdf`)
}
