'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { COMPANY, companyAddressLines } from '@/lib/company-config'
import {
  amountInWordsINR,
  financialYearLabel,
  fmtINR,
  type HsnSummaryRow,
} from '@/lib/indian-gst'

type LineItem = {
  id: string
  description: string
  hsnCode: string | null
  quantity: number
  rate: number
  gstPct: number
  taxableAmount: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  amount: number
}

type DispatchSummary = {
  id: string
  qtyDispatched: number
  vehicleNumber: string | null
  transporterName: string | null
  transportMode: string | null
  distanceKm: number | null
  ewayBillNumber: string | null
  dispatchedAt: string | null
  poLineItem: {
    cartonName: string | null
    hsnCode: string | null
    po: { poNumber: string | null } | null
  } | null
}

type Customer = {
  id: string
  name: string
  gstNumber: string | null
  pan: string | null
  stateCode: string | null
  billingAddress: string | null
  shippingAddress: string | null
  address: string | null
  contactPhone: string | null
}

type Bill = {
  id: string
  billNumber: string
  billDate: string
  financialYear: string | null
  placeOfSupplyStateCode: string | null
  taxSplit: string
  subtotal: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  gstAmount: number
  totalAmount: number
  hsnSummary: HsnSummaryRow[] | null
  transportMode: string | null
  transporterName: string | null
  vehicleNumber: string | null
  distanceKm: number | null
  ewayBillNumber: string | null
  ewayBillExpiry: string | null
  ewayApplicable: boolean
  status: string
  customer: Customer
  lineItems: LineItem[]
  dispatches: DispatchSummary[]
}

function fmtDate(iso?: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export default function BillPrintPage() {
  const params = useParams()
  const id = params.id as string
  const [bill, setBill] = useState<Bill | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/bills/${id}`)
      .then((r) => r.json())
      .then((b: Bill) => setBill(b))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="p-8 text-sm text-gray-600">Loading invoice…</div>
  if (!bill) return <div className="p-8 text-sm text-red-600">Bill not found.</div>

  const isIntra = bill.taxSplit === 'intra'
  const fyLabel = bill.financialYear ? financialYearLabel(bill.financialYear) : ''
  const billingAddress =
    bill.customer.billingAddress ?? bill.customer.address ?? ''
  const shippingAddress =
    bill.customer.shippingAddress ?? billingAddress

  return (
    <>
      {/* Inline print styles + page geometry. Keeps the print view self-contained. */}
      <style jsx global>{`
        @page {
          size: A4;
          margin: 14mm 12mm;
        }
        @media print {
          .no-print {
            display: none !important;
          }
          body {
            background: white !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
        .inv {
          color: #111;
          background: white;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 11px;
          line-height: 1.35;
        }
        .inv h1, .inv h2, .inv h3 {
          margin: 0;
          font-weight: 700;
        }
        .inv table {
          width: 100%;
          border-collapse: collapse;
        }
        .inv th, .inv td {
          border: 1px solid #888;
          padding: 4px 6px;
          vertical-align: top;
        }
        .inv th {
          background: #eee;
          text-align: left;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-weight: 700;
        }
        .inv td.num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
      `}</style>

      <div className="inv mx-auto max-w-[210mm] bg-white p-6 text-black">
        {/* Print toolbar (screen only) */}
        <div className="no-print mb-3 flex items-center justify-end gap-2">
          <button
            onClick={() => window.print()}
            className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Print invoice
          </button>
          <a
            href={`/billing/${bill.id}`}
            className="rounded border border-gray-400 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100"
          >
            Back to detail
          </a>
        </div>

        {/* Title bar */}
        <div className="mb-2 text-center">
          <div className="text-[10px] font-semibold uppercase tracking-widest">
            Tax Invoice
          </div>
          <div className="text-[10px] uppercase tracking-wider text-gray-700">
            (Original for Recipient · Duplicate for Transporter · Triplicate for Supplier)
          </div>
        </div>

        {/* Seller block + invoice header */}
        <table className="mb-0">
          <tbody>
            <tr>
              <td style={{ width: '60%' }}>
                <h1 className="text-base font-bold uppercase">{COMPANY.legalName}</h1>
                {companyAddressLines().map((l, i) => (
                  <div key={i} className="text-[11px]">
                    {l}
                  </div>
                ))}
                <div className="mt-1 text-[11px]">
                  <strong>GSTIN:</strong> {COMPANY.gstin || '—'} · <strong>PAN:</strong>{' '}
                  {COMPANY.pan || '—'}
                </div>
                {(COMPANY.phone || COMPANY.email) && (
                  <div className="text-[11px]">
                    {COMPANY.phone && <>Tel: {COMPANY.phone}</>}
                    {COMPANY.phone && COMPANY.email && ' · '}
                    {COMPANY.email && <>Email: {COMPANY.email}</>}
                  </div>
                )}
              </td>
              <td style={{ width: '40%' }}>
                <table className="text-[11px]">
                  <tbody>
                    <tr>
                      <td className="font-semibold uppercase">Invoice #</td>
                      <td className="font-mono">{bill.billNumber}</td>
                    </tr>
                    <tr>
                      <td className="font-semibold uppercase">Date</td>
                      <td>{fmtDate(bill.billDate)}</td>
                    </tr>
                    {fyLabel && (
                      <tr>
                        <td className="font-semibold uppercase">FY</td>
                        <td>{fyLabel}</td>
                      </tr>
                    )}
                    <tr>
                      <td className="font-semibold uppercase">Place of Supply</td>
                      <td>
                        {bill.placeOfSupplyStateCode ?? '—'} ·{' '}
                        {isIntra ? 'Intra-State' : 'Inter-State'}
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold uppercase">Reverse Charge</td>
                      <td>No</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Bill-to / Ship-to */}
        <table className="mt-0">
          <thead>
            <tr>
              <th style={{ width: '50%' }}>Bill To</th>
              <th style={{ width: '50%' }}>Ship To</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <div className="font-bold uppercase">{bill.customer.name}</div>
                <div className="whitespace-pre-line text-[11px]">{billingAddress}</div>
                <div className="mt-1 text-[11px]">
                  <strong>GSTIN:</strong> {bill.customer.gstNumber || '—'}
                  {bill.customer.stateCode && (
                    <>
                      {' '}
                      · <strong>State Code:</strong> {bill.customer.stateCode}
                    </>
                  )}
                </div>
                {bill.customer.pan && (
                  <div className="text-[11px]">
                    <strong>PAN:</strong> {bill.customer.pan}
                  </div>
                )}
              </td>
              <td>
                <div className="font-bold uppercase">{bill.customer.name}</div>
                <div className="whitespace-pre-line text-[11px]">{shippingAddress}</div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Line items */}
        <table className="mt-0">
          <thead>
            <tr>
              <th style={{ width: '4%' }}>#</th>
              <th>Description</th>
              <th style={{ width: '9%' }}>HSN</th>
              <th style={{ width: '8%' }} className="num">
                Qty
              </th>
              <th style={{ width: '9%' }} className="num">
                Rate
              </th>
              <th style={{ width: '6%' }} className="num">
                GST%
              </th>
              {isIntra ? (
                <>
                  <th style={{ width: '9%' }} className="num">
                    CGST
                  </th>
                  <th style={{ width: '9%' }} className="num">
                    SGST
                  </th>
                </>
              ) : (
                <th style={{ width: '12%' }} className="num">
                  IGST
                </th>
              )}
              <th style={{ width: '11%' }} className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {bill.lineItems.map((li, idx) => (
              <tr key={li.id}>
                <td>{idx + 1}</td>
                <td>{li.description}</td>
                <td className="font-mono">{li.hsnCode ?? '—'}</td>
                <td className="num">{li.quantity.toLocaleString('en-IN')}</td>
                <td className="num">{fmtINR(li.rate, { withSymbol: false })}</td>
                <td className="num">{li.gstPct}%</td>
                {isIntra ? (
                  <>
                    <td className="num">{fmtINR(li.cgstAmount, { withSymbol: false })}</td>
                    <td className="num">{fmtINR(li.sgstAmount, { withSymbol: false })}</td>
                  </>
                ) : (
                  <td className="num">{fmtINR(li.igstAmount, { withSymbol: false })}</td>
                )}
                <td className="num font-semibold">{fmtINR(li.amount, { withSymbol: false })}</td>
              </tr>
            ))}
            {/* Totals row */}
            <tr>
              <td colSpan={3} className="text-right font-semibold uppercase">
                Sub-total
              </td>
              <td className="num font-semibold">
                {bill.lineItems
                  .reduce((s, l) => s + l.quantity, 0)
                  .toLocaleString('en-IN')}
              </td>
              <td colSpan={2}></td>
              {isIntra ? (
                <>
                  <td className="num font-semibold">
                    {fmtINR(bill.cgstAmount, { withSymbol: false })}
                  </td>
                  <td className="num font-semibold">
                    {fmtINR(bill.sgstAmount, { withSymbol: false })}
                  </td>
                </>
              ) : (
                <td className="num font-semibold">
                  {fmtINR(bill.igstAmount, { withSymbol: false })}
                </td>
              )}
              <td className="num font-bold">{fmtINR(bill.totalAmount, { withSymbol: false })}</td>
            </tr>
          </tbody>
        </table>

        {/* HSN summary (footer table) */}
        {bill.hsnSummary && bill.hsnSummary.length > 0 && (
          <table className="mt-0">
            <thead>
              <tr>
                <th colSpan={isIntra ? 6 : 5} className="text-center">
                  HSN Summary
                </th>
              </tr>
              <tr>
                <th>HSN</th>
                <th className="num">Taxable Value</th>
                {isIntra ? (
                  <>
                    <th className="num">CGST</th>
                    <th className="num">SGST</th>
                  </>
                ) : (
                  <th className="num">IGST</th>
                )}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {bill.hsnSummary.map((row) => (
                <tr key={row.hsn}>
                  <td className="font-mono">{row.hsn}</td>
                  <td className="num">{fmtINR(row.taxableValue, { withSymbol: false })}</td>
                  {isIntra ? (
                    <>
                      <td className="num">{fmtINR(row.cgst, { withSymbol: false })}</td>
                      <td className="num">{fmtINR(row.sgst, { withSymbol: false })}</td>
                    </>
                  ) : (
                    <td className="num">{fmtINR(row.igst, { withSymbol: false })}</td>
                  )}
                  <td className="num font-semibold">{fmtINR(row.total, { withSymbol: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Amount in words + grand total */}
        <table className="mt-0">
          <tbody>
            <tr>
              <td style={{ width: '70%' }}>
                <div className="text-[10px] font-semibold uppercase tracking-wider">
                  Amount Chargeable (In Words)
                </div>
                <div className="text-[12px] font-semibold">
                  {amountInWordsINR(bill.totalAmount)}
                </div>
              </td>
              <td style={{ width: '30%' }} className="num">
                <div className="text-[10px] font-semibold uppercase tracking-wider">
                  Grand Total
                </div>
                <div className="text-[14px] font-bold">{fmtINR(bill.totalAmount)}</div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Transport / E-way block */}
        {(bill.transportMode ||
          bill.vehicleNumber ||
          bill.transporterName ||
          bill.ewayBillNumber ||
          bill.ewayApplicable) && (
          <table className="mt-0">
            <thead>
              <tr>
                <th colSpan={4} className="text-center">
                  Transport & E-Way
                </th>
              </tr>
              <tr>
                <th>Mode</th>
                <th>Transporter</th>
                <th>Vehicle #</th>
                <th>Distance (km)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{bill.transportMode ?? '—'}</td>
                <td>{bill.transporterName ?? '—'}</td>
                <td className="font-mono">{bill.vehicleNumber ?? '—'}</td>
                <td className="num">{bill.distanceKm ?? '—'}</td>
              </tr>
              {(bill.ewayBillNumber || bill.ewayApplicable) && (
                <tr>
                  <td colSpan={4}>
                    <strong>E-Way Bill:</strong>{' '}
                    {bill.ewayBillNumber ? (
                      <span className="font-mono">{bill.ewayBillNumber}</span>
                    ) : bill.ewayApplicable ? (
                      <span className="text-red-600">
                        APPLICABLE — please generate before dispatch
                      </span>
                    ) : (
                      'Not applicable'
                    )}
                    {bill.ewayBillExpiry && <> · Expires {fmtDate(bill.ewayBillExpiry)}</>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {/* Dispatches (delivery challan summary) */}
        {bill.dispatches.length > 0 && (
          <table className="mt-0">
            <thead>
              <tr>
                <th colSpan={4} className="text-center">
                  Delivery / Dispatch References
                </th>
              </tr>
              <tr>
                <th>Dispatch Date</th>
                <th>Product · PO</th>
                <th className="num">Qty</th>
                <th>Vehicle</th>
              </tr>
            </thead>
            <tbody>
              {bill.dispatches.map((d) => (
                <tr key={d.id}>
                  <td>{fmtDate(d.dispatchedAt)}</td>
                  <td>
                    {d.poLineItem?.cartonName ?? '—'}
                    {d.poLineItem?.po?.poNumber && <> · {d.poLineItem.po.poNumber}</>}
                  </td>
                  <td className="num">{d.qtyDispatched.toLocaleString('en-IN')}</td>
                  <td className="font-mono">{d.vehicleNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Bank details + signature */}
        <table className="mt-0">
          <tbody>
            <tr>
              <td style={{ width: '60%' }}>
                <div className="text-[10px] font-semibold uppercase tracking-wider">
                  Bank Details
                </div>
                {COMPANY.bankName && (
                  <div className="text-[11px]">{COMPANY.bankName}</div>
                )}
                {COMPANY.bankBranch && (
                  <div className="text-[11px]">{COMPANY.bankBranch}</div>
                )}
                {COMPANY.bankAccount && (
                  <div className="text-[11px]">A/c No: {COMPANY.bankAccount}</div>
                )}
                {COMPANY.bankIfsc && (
                  <div className="text-[11px]">IFSC: {COMPANY.bankIfsc}</div>
                )}
                <div className="mt-3 text-[10px] uppercase tracking-wider text-gray-600">
                  Declaration
                </div>
                <div className="text-[10px]">
                  We declare that this invoice shows the actual price of the goods described
                  and that all particulars are true and correct.
                </div>
              </td>
              <td style={{ width: '40%' }} className="align-bottom">
                <div className="text-center">
                  <div className="text-[10px] uppercase tracking-wider">
                    For {COMPANY.legalName}
                  </div>
                  <div style={{ height: 60 }} />
                  <div className="border-t border-gray-700 pt-1 text-[10px] uppercase tracking-wider">
                    Authorised Signatory
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <div className="mt-2 text-center text-[10px] text-gray-600">
          This is a computer-generated invoice and does not require a physical signature when
          digitally authenticated.
        </div>
      </div>
    </>
  )
}
