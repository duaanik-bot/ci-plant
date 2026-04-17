import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

export type CustomerPoPdfLine = {
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate: number | null
  gstPct: number
  artworkCode: string | null
}

export function buildCustomerPurchaseOrderPdfBuffer(params: {
  poNumber: string
  poDateYmd: string
  status: string
  customerName: string
  customerGst: string | null
  deliveryYmd: string | null
  remarks: string | null
  lines: CustomerPoPdfLine[]
}): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 14
  let y = margin

  doc.setFontSize(15)
  doc.setFont('helvetica', 'bold')
  doc.text('Darbi Print Pack / Colour Impressions', margin, y)
  y += 7
  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.text('Customer purchase order', margin, y)
  y += 9

  doc.setFontSize(10)
  doc.text(`PO #: ${params.poNumber}`, margin, y)
  y += 5
  doc.text(`Date: ${params.poDateYmd}`, margin, y)
  y += 5
  doc.text(`Status: ${params.status}`, margin, y)
  y += 5
  doc.text(`Customer: ${params.customerName}`, margin, y)
  y += 5
  if (params.customerGst?.trim()) {
    doc.text(`Customer GST: ${params.customerGst.trim()}`, margin, y)
    y += 5
  }
  doc.text(`Delivery required: ${params.deliveryYmd ?? '—'}`, margin, y)
  y += 8

  const body: (string | number)[][] = []
  let subExcl = 0
  let totalGst = 0

  for (const ln of params.lines) {
    const rate = ln.rate != null ? Number(ln.rate) : 0
    const before = rate * ln.quantity
    const gst = before * (ln.gstPct / 100)
    const lineTot = before + gst
    subExcl += before
    totalGst += gst
    body.push([
      ln.cartonName,
      ln.cartonSize?.trim() || '—',
      ln.quantity,
      rate ? rate.toFixed(2) : '—',
      `${ln.gstPct}%`,
      before.toFixed(2),
      gst.toFixed(2),
      lineTot.toFixed(2),
      ln.artworkCode?.trim() || '—',
    ])
  }

  autoTable(doc, {
    startY: y,
    head: [
      [
        'Carton',
        'Size',
        'Qty',
        'Rate ₹',
        'GST%',
        'Taxable ₹',
        'GST ₹',
        'Line ₹',
        'Artwork',
      ],
    ],
    body,
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    margin: { left: margin, right: margin },
  })

  const docWithTable = doc as jsPDF & { lastAutoTable?: { finalY: number } }
  y = (docWithTable.lastAutoTable?.finalY ?? y) + 8

  doc.setFontSize(10)
  doc.text(`Subtotal (excl. GST): ₹${subExcl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, margin, y)
  y += 5
  doc.text(`GST: ₹${totalGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, margin, y)
  y += 6
  doc.setFont('helvetica', 'bold')
  doc.text(
    `Grand total: ₹${(subExcl + totalGst).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    margin,
    y,
  )
  y += 8
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(100)
  doc.text('Prepared by: Anik Dua', margin, y)
  y += 5
  if (params.remarks?.trim()) {
    doc.text(`Remarks: ${params.remarks.trim()}`, margin, y)
    y += 5
  }
  doc.text('Computer-generated document. Signatures on file for authorised orders.', margin, y)

  return Buffer.from(doc.output('arraybuffer'))
}
