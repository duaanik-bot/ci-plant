export type GrnReturnGatePassInput = {
  poNumber: string
  scaleSlipId: string
  vehicleNumber: string
  transporterName: string | null
  rejectionReason: string | null
  rejectionRemarks: string | null
  returnQtyKg: number
  generatedAtIso: string
  generatedByLabel: string
}

export function buildGrnReturnGatePassHtml(p: GrnReturnGatePassInput): string {
  const transporter = (p.transporterName ?? '—').trim() || '—'
  const reason = (p.rejectionReason ?? '—').trim() || '—'
  const remarks = (p.rejectionRemarks ?? '—').trim() || '—'
  const when = new Date(p.generatedAtIso)
  const whenStr = Number.isNaN(when.getTime())
    ? p.generatedAtIso
    : when.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Return gate pass · ${escapeHtml(p.scaleSlipId)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #000; color: #fafafa; padding: 24px; }
    .card { max-width: 520px; margin: 0 auto; border: 2px solid #f59e0b; border-radius: 12px; padding: 20px 22px; background: #0a0a0a; }
    h1 { margin: 0 0 4px; font-size: 15px; letter-spacing: 0.06em; text-transform: uppercase; color: #fbbf24; }
    .sub { margin: 0 0 16px; font-size: 11px; color: #a3a3a3; }
    dl { margin: 0; display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; font-size: 12px; }
    dt { color: #737373; font-weight: 600; }
    dd { margin: 0; font-family: ui-monospace, monospace; color: #e5e5e5; }
    .weight { font-size: 20px; font-weight: 800; color: #fb7185; letter-spacing: -0.02em; }
    .foot { margin-top: 18px; padding-top: 12px; border-top: 1px solid #262626; font-size: 10px; color: #525252; }
    @media print { body { background: #fff; color: #000; } .card { border-color: #000; background: #fff; } h1 { color: #000; } dt { color: #444; } dd { color: #111; } .weight { color: #000; } .foot { color: #333; border-color: #ccc; } }
  </style>
</head>
<body>
  <div class="card">
    <h1>Material return — gate pass</h1>
    <p class="sub">PO ${escapeHtml(p.poNumber)} · Slip ${escapeHtml(p.scaleSlipId)}</p>
    <dl>
      <dt>Vehicle</dt><dd>${escapeHtml(p.vehicleNumber)}</dd>
      <dt>Transporter</dt><dd>${escapeHtml(transporter)}</dd>
      <dt>Reason</dt><dd>${escapeHtml(reason)}</dd>
      <dt>Remarks</dt><dd>${escapeHtml(remarks)}</dd>
      <dt>Weight to return</dt><dd class="weight">${p.returnQtyKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg</dd>
    </dl>
    <div class="foot">
      Issued ${escapeHtml(whenStr)} · ${escapeHtml(p.generatedByLabel)}
    </div>
  </div>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
