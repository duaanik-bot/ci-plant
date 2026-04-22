'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type PlateRow = { status: string }
type DieRow = { status: string }
type EmbossRow = { status: string }
type AlertRow = { id?: string; title?: string; message?: string; severity?: string; category?: string }

export default function ToolsHubPage() {
  const [plates, setPlates] = useState<PlateRow[]>([])
  const [dies, setDies] = useState<DieRow[]>([])
  const [blocks, setBlocks] = useState<EmbossRow[]>([])
  const [alerts, setAlerts] = useState<AlertRow[]>([])

  useEffect(() => {
    async function load() {
      const [pRes, dRes, bRes, aRes] = await Promise.all([
        fetch('/api/plate-store'),
        fetch('/api/die-store'),
        fetch('/api/emboss-blocks'),
        fetch('/api/dashboard/alerts'),
      ])
      const [pJson, dJson, bJson, aJson] = await Promise.all([
        pRes.json(),
        dRes.json(),
        bRes.json(),
        aRes.json(),
      ])
      setPlates(Array.isArray(pJson) ? pJson : [])
      setDies(Array.isArray(dJson) ? dJson : [])
      setBlocks(Array.isArray(bJson) ? bJson : [])
      setAlerts(Array.isArray(aJson) ? aJson : [])
    }
    load().catch(() => {})
  }, [])

  const plateStats = useMemo(
    () => ({
      inRack: plates.filter((p) => p.status === 'ready' || p.status === 'returned').length,
      issued: plates.filter((p) => p.status === 'issued').length,
      ctpPending: plates.filter((p) => p.status === 'pending').length,
    }),
    [plates],
  )

  const dieStats = useMemo(
    () => ({
      inStock: dies.filter((d) => d.status === 'in_stock').length,
      issued: dies.filter((d) => d.status === 'issued').length,
      withVendor: dies.filter((d) => d.status === 'with_vendor').length,
    }),
    [dies],
  )

  const embossStats = useMemo(
    () => ({
      inStock: blocks.filter((b) => b.status === 'in_stock').length,
      issued: blocks.filter((b) => b.status === 'issued').length,
      withVendor: blocks.filter((b) => b.status === 'with_vendor').length,
    }),
    [blocks],
  )

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-ds-warning">Tools Hub - Pre-Press Inventory</h1>
        <p className="text-sm text-ds-ink-muted">
          Central control for Plates, Dies, and Embossing Blocks
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <section className="rounded-xl border border-ds-line/50 bg-ds-card p-4 space-y-2">
          <p className="text-xs text-ds-ink-muted">PLATE HUB</p>
          <p className="text-2xl">🖨️</p>
          <p className="text-sm text-ds-ink">
            {plateStats.inRack} in rack | {plateStats.issued} issued | {plateStats.ctpPending} CTP pending
          </p>
          <div className="h-2 rounded bg-ds-elevated overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, plateStats.inRack * 10)}%` }} />
          </div>
          <Link href="/pre-press/plate-store" className="text-sm text-ds-warning hover:underline">
            Open Plate Hub →
          </Link>
        </section>

        <section className="rounded-xl border border-ds-line/50 bg-ds-card p-4 space-y-2">
          <p className="text-xs text-ds-ink-muted">DIE INVENTORY</p>
          <p className="text-2xl">✂️</p>
          <p className="text-sm text-ds-ink">
            {dieStats.inStock} in stock | {dieStats.issued} issued | {dieStats.withVendor} with vendor
          </p>
          <Link href="/masters/dies" className="text-sm text-ds-warning hover:underline">
            Open Die Inventory →
          </Link>
        </section>

        <section className="rounded-xl border border-ds-line/50 bg-ds-card p-4 space-y-2">
          <p className="text-xs text-ds-ink-muted">EMBOSS BLOCKS</p>
          <p className="text-2xl">🔲</p>
          <p className="text-sm text-ds-ink">
            {embossStats.inStock} in stock | {embossStats.issued} issued | {embossStats.withVendor} with vendor
          </p>
          <p className="text-xs text-ds-ink-faint">Conditional - activates based on Product Master</p>
          <Link href="/masters/emboss-blocks" className="text-sm text-ds-warning hover:underline">
            Open Emboss Inventory →
          </Link>
        </section>
      </div>

      <section className="rounded-xl border border-ds-line/50 bg-ds-card p-4">
        <h2 className="text-sm font-semibold text-ds-ink mb-2">Alerts</h2>
        <div className="space-y-2 text-sm">
          {alerts.length === 0 ? <p className="text-ds-ink-faint">No tool-related alerts.</p> : null}
          {alerts.slice(0, 10).map((a, idx) => (
            <div key={a.id ?? idx} className="rounded border border-ds-line/50 px-3 py-2 text-ds-ink-muted">
              {a.title || a.message || 'Alert'}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
