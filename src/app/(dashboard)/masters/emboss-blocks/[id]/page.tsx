'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'

type BlockDetail = {
  id: string
  blockCode: string
  blockNumber: number | null
  blockType: string
  blockMaterial: string
  blockSizeL: string | null
  blockSizeW: string | null
  embossDepth: string | null
  embossArea: string | null
  registerTolerance: string | null
  storageLocation: string | null
  compartment: string | null
  vendorName: string | null
  vendorOrderRef: string | null
  manufacturingCost: string | null
  receivedDate: string | null
  cartonName: string | null
  customerId: string | null
  artworkCode: string | null
  impressionCount: number
  maxImpressions: number
  polishCount: number
  maxPolishCount: number
  condition: string
  status: string
  issueRecords: Array<{ id: string; issuedTo: string; issuedAt: string; status: string; jobCardNumber: number | null }>
  maintenanceLogV2: Array<{ id: string; actionType: string; performedAt: string; conditionBefore: string | null; conditionAfter: string | null; cost: string | null }>
  vendorOrders: Array<{ id: string; orderCode: string; orderType: string; vendorName: string; status: string; orderedAt: string }>
  auditLog: Array<{ id: string; action: string; performedBy: string; performedAt: string }>
}

export default function EmbossBlockDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [block, setBlock] = useState<BlockDetail | null>(null)
  const [tab, setTab] = useState<'overview' | 'issue' | 'vendor' | 'history' | 'audit'>('overview')

  useEffect(() => {
    fetch(`/api/emboss-blocks/${id}`).then((r) => r.json()).then((d) => setBlock(d))
  }, [id])

  if (!block) return <div className="p-4 text-slate-400">Loading...</div>
  const lifePct = block.maxImpressions > 0 ? Math.min(100, Math.round((block.impressionCount / block.maxImpressions) * 100)) : 0

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <Link href="/masters/emboss-blocks" className="text-slate-400 hover:text-white text-sm">← Emboss Blocks</Link>
      <div>
        <h1 className="text-xl font-bold text-amber-400">{block.blockCode}</h1>
        <p className="text-slate-400 text-sm">Block No. {block.blockNumber ?? '-'} · {block.status}</p>
      </div>
      <div className="flex gap-2">
        {(['overview', 'issue', 'vendor', 'history', 'audit'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded border text-xs ${tab === t ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-3 text-sm">
          <div className="grid md:grid-cols-4 gap-2">
            <Info k="Type" v={block.blockType} /><Info k="Material" v={block.blockMaterial} />
            <Info k="Size" v={`${block.blockSizeL ?? '-'} × ${block.blockSizeW ?? '-'}`} />
            <Info k="Emboss Depth" v={block.embossDepth ?? '-'} />
            <Info k="Emboss Area" v={block.embossArea ?? '-'} />
            <Info k="Tolerance" v={block.registerTolerance ?? '-'} />
            <Info k="Location" v={block.storageLocation ?? '-'} />
            <Info k="Compartment" v={block.compartment ?? '-'} />
            <Info k="Vendor" v={block.vendorName ?? '-'} />
            <Info k="Vendor Ref" v={block.vendorOrderRef ?? '-'} />
            <Info k="Cost" v={block.manufacturingCost ?? '-'} />
            <Info k="Received" v={block.receivedDate ? new Date(block.receivedDate).toLocaleDateString('en-IN') : '-'} />
          </div>
          <div>
            <p className="text-slate-300 mb-1">Impression Meter</p>
            <div className="h-3 rounded bg-slate-700 overflow-hidden"><div className={`${lifePct > 85 ? 'bg-red-500' : lifePct > 70 ? 'bg-amber-500' : 'bg-green-500'} h-full`} style={{ width: `${lifePct}%` }} /></div>
            <p className="text-xs text-slate-400 mt-1">
              {block.impressionCount.toLocaleString()} / {block.maxImpressions.toLocaleString()} · Polish cycles {block.polishCount}/{block.maxPolishCount}
            </p>
          </div>
        </div>
      )}

      {tab === 'issue' && <IssueReturn block={block} />}

      {tab === 'vendor' && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <table className="w-full text-xs">
            <thead className="text-slate-400"><tr><th className="text-left">Order</th><th className="text-left">Type</th><th className="text-left">Vendor</th><th className="text-left">Status</th></tr></thead>
            <tbody>{block.vendorOrders.map((o) => <tr key={o.id} className="border-t border-slate-800"><td className="py-1">{o.orderCode}</td><td>{o.orderType}</td><td>{o.vendorName}</td><td>{o.status}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      {tab === 'history' && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-2 text-sm">
          {block.issueRecords.map((r) => <div key={r.id} className="border border-slate-800 rounded p-2">Issued to {r.issuedTo} · {new Date(r.issuedAt).toLocaleString('en-IN')} · {r.status}</div>)}
        </div>
      )}

      {tab === 'audit' && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-2 text-xs">
          {block.auditLog.map((a) => <div key={a.id} className="grid grid-cols-3 border-b border-slate-800 pb-1"><span>{new Date(a.performedAt).toLocaleString('en-IN')}</span><span>{a.action}</span><span>{a.performedBy}</span></div>)}
        </div>
      )}
    </div>
  )
}

function Info({ k, v }: { k: string; v: string }) {
  return <div><span className="text-slate-500">{k}</span> <span className="text-slate-200">{v}</span></div>
}

function IssueReturn({ block }: { block: BlockDetail }) {
  const [jobCardId, setJobCardId] = useState('')
  const [jobCardNumber, setJobCardNumber] = useState('')
  const [issuedTo, setIssuedTo] = useState('')
  const [machineCode, setMachineCode] = useState('EMB-01')
  const [impressionsThisRun, setImpressionsThisRun] = useState('')
  const [returnCondition, setReturnCondition] = useState('Good')
  const [actionTaken, setActionTaken] = useState('store')
  const [returnNotes, setReturnNotes] = useState('')
  const [storageLocation, setStorageLocation] = useState(block.storageLocation || '')

  async function issue() {
    await fetch(`/api/emboss-blocks/${block.id}/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobCardId, jobCardNumber: Number(jobCardNumber), machineCode, issuedTo }),
    })
    window.location.reload()
  }
  async function ret() {
    const issueRecordId = block.issueRecords.find((r) => r.status === 'issued')?.id
    if (!issueRecordId) return
    await fetch(`/api/emboss-blocks/${block.id}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueRecordId,
        returnedBy: issuedTo || 'OPERATOR',
        impressionsThisRun: Number(impressionsThisRun || 0),
        returnCondition,
        actionTaken,
        returnNotes,
        storageLocation,
      }),
    })
    window.location.reload()
  }

  return block.status === 'issued' ? (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-2 text-sm">
      <p className="text-slate-300">Currently issued. Return required.</p>
      <input value={impressionsThisRun} onChange={(e) => setImpressionsThisRun(e.target.value)} placeholder="Impressions this run" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full" />
      <select value={returnCondition} onChange={(e) => setReturnCondition(e.target.value)} className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full">
        <option>Good</option><option>Fair</option><option>Needs Polish</option><option>Damaged</option>
      </select>
      <select value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full">
        <option value="store">store</option><option value="sent_for_polishing">sent_for_polishing</option><option value="scrapped">scrapped</option>
      </select>
      <input value={storageLocation} onChange={(e) => setStorageLocation(e.target.value)} placeholder="Storage location" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full" />
      <textarea value={returnNotes} onChange={(e) => setReturnNotes(e.target.value)} placeholder="Notes" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full" />
      <button onClick={ret} className="px-3 py-2 rounded bg-amber-600 text-white text-xs">Confirm Return</button>
    </div>
  ) : (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-2 text-sm">
      <input value={jobCardId} onChange={(e) => setJobCardId(e.target.value)} placeholder="Job Card ID" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full" />
      <input value={jobCardNumber} onChange={(e) => setJobCardNumber(e.target.value)} placeholder="Job Card Number" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full" />
      <input value={issuedTo} onChange={(e) => setIssuedTo(e.target.value)} placeholder="Issue to operator" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full" />
      <select value={machineCode} onChange={(e) => setMachineCode(e.target.value)} className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm w-full"><option>EMB-01</option><option>EMB-02</option></select>
      <button onClick={issue} className="px-3 py-2 rounded bg-amber-600 text-white text-xs">Issue Block</button>
    </div>
  )
}

