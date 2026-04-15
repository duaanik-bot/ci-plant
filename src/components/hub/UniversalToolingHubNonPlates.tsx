'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import type { HubIncomingUnified, HubToolType, VendorPipelineStage } from '@/lib/hub-types'
import { vendorStageLabel } from '@/lib/hub-types'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { HubDieDecisionStrip } from '@/components/hub/HubDieDecisionStrip'
import { RACK_COLS } from '@/lib/plate-rack'
import { getHubCustodyDemoRows } from '@/lib/hub-workboard-mocks'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import { HUB_TECHNICAL_DATA_MISSING_TOAST, validatePayload } from '@/lib/validate-hub-payload'

const PIPELINE: VendorPipelineStage[] = [
  'po_raised',
  'in_production',
  'dispatched',
  'received_triage',
]

/** Placeholder UUIDs for traceability until job/artwork pickers are wired. */
const DEMO_JOB_CARD_ID = '00000000-0000-4000-8000-000000000001'
const DEMO_ARTWORK_ID = '00000000-0000-4000-8000-000000000002'
const DEMO_SET_NUMBER = '01'

function VendorPill({ stage, active }: { stage: VendorPipelineStage; active: VendorPipelineStage }) {
  const i = PIPELINE.indexOf(stage)
  const ai = PIPELINE.indexOf(active)
  const done = i < ai
  const current = i === ai
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-medium border ${
        current
          ? 'bg-amber-700/90 border-amber-500 text-white'
          : done
            ? 'bg-emerald-900/40 border-emerald-700 text-emerald-200'
            : 'bg-slate-800 border-slate-600 text-slate-500'
      }`}
    >
      {vendorStageLabel(stage)}
    </span>
  )
}

export function UniversalToolingHubNonPlates({ toolType }: { toolType: Exclude<HubToolType, 'plates'> }) {
  const [rows, setRows] = useState<HubIncomingUnified[]>([])
  const [loading, setLoading] = useState(true)
  const [triageMode, setTriageMode] = useState<'new' | 'retrieve'>('new')
  const [invSearch, setInvSearch] = useState('')

  const [embossBlocks, setEmbossBlocks] = useState<Array<{ id: string; blockCode: string; condition: string }>>(
    [],
  )
  const [blockPick, setBlockPick] = useState('')
  const [blockCond, setBlockCond] = useState<'Perfect' | 'Worn Out' | 'Needs Replacement'>('Perfect')
  const [shadeSlots, setShadeSlots] = useState<
    Array<{
      slot: string
      holder: string
      ref: string
      approvalDate: string | null
      masterArtworkRef: string
      previewUrl: string | null
    }>
  >([])

  const [returnOpen, setReturnOpen] = useState(false)
  const [returnImpressions, setReturnImpressions] = useState<number | ''>('')
  const [returnRack, setReturnRack] = useState('')
  const [returnJobCardId, setReturnJobCardId] = useState(DEMO_JOB_CARD_ID)
  const [returnArtworkId, setReturnArtworkId] = useState(DEMO_ARTWORK_ID)
  const [returnSetNumber, setReturnSetNumber] = useState(DEMO_SET_NUMBER)
  const [selectedCustodyIds, setSelectedCustodyIds] = useState<string[]>([])
  const [returnToolCondition, setReturnToolCondition] = useState<'Good' | 'Damaged' | 'Needs Repair'>('Good')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/hub/incoming?toolType=${toolType}`)
      const text = await r.text()
      const j = safeJsonParse<unknown>(text, [])
      setRows(Array.isArray(j) ? (j as HubIncomingUnified[]) : [])
      if (toolType === 'blocks') {
        const br = await fetch('/api/emboss-blocks')
        const bt = await br.text()
        const bj = safeJsonParse<unknown>(bt, [])
        if (Array.isArray(bj)) {
          setEmbossBlocks(
            bj.map((x: { id: string; blockCode: string; condition: string }) => ({
              id: x.id,
              blockCode: x.blockCode,
              condition: x.condition,
            })),
          )
        }
      }
      if (toolType === 'shade_cards') {
        setShadeSlots([
          {
            slot: 'A1',
            holder: 'Ink Lab',
            ref: 'SC-001',
            approvalDate: new Date().toISOString().slice(0, 10),
            masterArtworkRef: 'MA-ART-001',
            previewUrl: null,
          },
          {
            slot: 'B2',
            holder: 'Stores',
            ref: 'SC-002',
            approvalDate: '2026-03-15',
            masterArtworkRef: 'MA-ART-088',
            previewUrl: null,
          },
        ])
      }
    } catch {
      toast.error('Failed to load hub')
    } finally {
      setLoading(false)
    }
  }, [toolType])

  useEffect(() => {
    void load()
  }, [load])

  const title = useMemo(() => {
    if (toolType === 'dies') return 'Die Hub'
    if (toolType === 'blocks') return 'Emboss Block Hub'
    return 'Shade Card Hub'
  }, [toolType])

  const incomingDisplay = useMemo(() => {
    if (triageMode === 'new') return rows
    return []
  }, [rows, triageMode])

  const custodyRows = useMemo(() => getHubCustodyDemoRows(toolType), [toolType])

  const inventoryFiltered = useMemo(() => {
    const q = invSearch.trim().toLowerCase()
    if (toolType === 'shade_cards') {
      if (!q) return shadeSlots
      return shadeSlots.filter(
        (s) =>
          s.slot.toLowerCase().includes(q) ||
          s.ref.toLowerCase().includes(q) ||
          s.holder.toLowerCase().includes(q) ||
          s.masterArtworkRef.toLowerCase().includes(q),
      )
    }
    if (!q) return embossBlocks
    return embossBlocks.filter(
      (b) =>
        b.blockCode.toLowerCase().includes(q) ||
        b.condition.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q),
    )
  }, [invSearch, shadeSlots, embossBlocks, toolType])

  const sharpen = async (dieId: string) => {
    try {
      const res = await fetch(`/api/hub/dies/${dieId}/sharpening`, { method: 'POST' })
      const text = await res.text()
      const j = safeJsonParse<{ sharpenCount?: number; error?: string }>(text, {})
      if (!res.ok) throw new Error(j.error || 'Failed')
      toast.success(`Sharpening logged · re-edge count: ${j.sharpenCount ?? '—'}`)
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  const saveBlockCondition = async () => {
    if (!blockPick) {
      toast.error('Select a block')
      return
    }
    try {
      const body = safeJsonStringify({ condition: blockCond })
      const res = await fetch(`/api/emboss-blocks/${blockPick}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await res.text()
      const j = safeJsonParse<{ error?: string }>(text, {})
      if (!res.ok) throw new Error(j.error || 'Update failed')
      toast.success('Block condition updated')
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  const toggleCustodySelect = (id: string) => {
    setSelectedCustodyIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const submitHubReturn = async () => {
    const recordIds =
      selectedCustodyIds.length > 0 ? selectedCustodyIds : []
    if (recordIds.length === 0) {
      toast.error('Select at least one tool on the floor')
      return
    }
    if (returnImpressions === '' || Number(returnImpressions) < 0 || !returnRack.trim()) {
      toast.error('Impression count and rack slot are required')
      return
    }
    const pre = validatePayload({
      artworkId: returnArtworkId,
      jobCardId: returnJobCardId,
      setNumber: returnSetNumber,
    })
    if (!pre.ok) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return
    }
    if (toolType !== 'dies' && toolType !== 'blocks') return
    try {
      for (const recordId of recordIds) {
        const payload = {
          toolType,
          recordId,
          impressions: Number(returnImpressions),
          rackSlot: returnRack.trim(),
          jobCardId: returnJobCardId.trim(),
          artworkId: returnArtworkId.trim(),
          setNumber: returnSetNumber.trim(),
          condition: returnToolCondition,
        }
        const res = await fetch('/api/hub/custody/return', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: safeJsonStringify(payload),
        })
        const text = await res.text()
        const j = safeJsonParse<{ error?: string; details?: Record<string, string[]> }>(text, {})
        if (!res.ok) throw new Error(j.error || 'Failed')
      }
      toast.success(
        recordIds.length > 1
          ? `Return logged for ${recordIds.length} tools`
          : 'Return logged with impressions',
      )
      setReturnOpen(false)
      setReturnImpressions('')
      setReturnRack('')
      setReturnJobCardId(DEMO_JOB_CARD_ID)
      setReturnArtworkId(DEMO_ARTWORK_ID)
      setReturnSetNumber(DEMO_SET_NUMBER)
      setSelectedCustodyIds([])
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  if (loading && rows.length === 0) {
    return (
      <div className="h-[calc(100dvh-4rem)] flex items-center justify-center bg-slate-950 text-slate-400">
        Loading {title}…
      </div>
    )
  }

  const toggleBtn = (active: boolean) =>
    `px-3 py-1.5 text-[11px] font-semibold rounded-md border transition-colors ${
      active
        ? 'bg-amber-700/90 border-amber-500 text-white'
        : 'bg-slate-800/90 border-slate-600 text-slate-300 hover:bg-slate-700'
    }`

  return (
    <div className="flex flex-col min-h-[calc(100dvh-4rem)] max-w-[1920px] mx-auto w-full bg-slate-950 text-white">
      <header className="sticky top-0 z-30 border-b border-slate-700 bg-slate-950/95 backdrop-blur-sm px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-cyan-400">Universal Tooling Hub</h1>
            <p className="text-[11px] text-slate-500">{title} · live workboard</p>
          </div>
          <Link
            href="/masters/dies"
            className="text-xs text-amber-400 hover:underline hidden md:inline"
          >
            Masters →
          </Link>
        </div>
        <HubCategoryNav active={toolType} />
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-4 gap-0 xl:divide-x divide-slate-800">
        {/* Zone 1 — Incoming triage */}
        <section className="min-h-0 overflow-y-auto p-4 border-b xl:border-b-0 border-slate-800 flex flex-col gap-3">
          {toolType === 'dies' ? (
            <HubDieDecisionStrip rackAnchorId="die-live-rack" vendorAnchorId="die-procurement" />
          ) : null}
          <div>
            <h2 className="text-sm font-semibold text-amber-200/95 uppercase tracking-wide">1 · Incoming triage</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Staging from pre-press · choose flow</p>
          </div>
          <div
            className="inline-flex rounded-lg border border-slate-600 bg-slate-900/80 p-0.5 gap-0.5"
            role="group"
            aria-label="Production source"
          >
            <button type="button" className={toggleBtn(triageMode === 'new')} onClick={() => setTriageMode('new')}>
              New production
            </button>
            <button
              type="button"
              className={toggleBtn(triageMode === 'retrieve')}
              onClick={() => setTriageMode('retrieve')}
            >
              Retrieve from inventory
            </button>
          </div>

          {triageMode === 'retrieve' ? (
            <p className="text-[11px] text-slate-400 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              No jobs in staging for retrieval. Use{' '}
              <span className="text-cyan-300">column 3 · Live inventory</span> to locate the physical asset and book it
              out to the floor.
            </p>
          ) : (
            <div className="rounded-xl border border-slate-700 bg-slate-900/95 overflow-hidden flex-1 min-h-[12rem] flex flex-col">
              <div className="overflow-x-auto overflow-y-auto flex-1">
                <table className="w-full text-left text-xs min-w-[28rem]">
                  <thead className="bg-slate-800/80 text-slate-400 uppercase sticky top-0">
                    <tr>
                      <th className="p-2">Code</th>
                      <th className="p-2">Details</th>
                      {toolType === 'dies' ? (
                        <>
                          <th className="p-2">L×W×H</th>
                          <th className="p-2">UPS</th>
                        </>
                      ) : null}
                      {toolType === 'blocks' ? <th className="p-2">Emboss / Leaf</th> : null}
                      {toolType === 'shade_cards' ? (
                        <>
                          <th className="p-2">Approval</th>
                          <th className="p-2">Master ref</th>
                        </>
                      ) : null}
                      <th className="p-2">Vendor</th>
                      {toolType === 'dies' ? <th className="p-2">Action</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {incomingDisplay.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="p-4 text-slate-500 text-center">
                          No incoming items.
                        </td>
                      </tr>
                    ) : (
                      incomingDisplay.map((r) => (
                        <tr key={r.id} className="border-t border-slate-800 align-top">
                          <td className="p-2 font-mono text-cyan-300 whitespace-nowrap">{r.code}</td>
                          <td className="p-2">
                            <div className="font-medium text-slate-200 text-balance">{r.title}</div>
                            <div className="text-slate-500">{r.subtitle || '—'}</div>
                          </td>
                          {toolType === 'dies' ? (
                            <>
                              <td className="p-2 text-[11px] whitespace-nowrap">
                                {[r.lengthMm, r.widthMm, r.heightMm].every((x) => x == null)
                                  ? '—'
                                  : `${r.lengthMm ?? '—'} × ${r.widthMm ?? '—'} × ${r.heightMm ?? '—'}`}
                              </td>
                              <td className="p-2">{r.ups ?? '—'}</td>
                            </>
                          ) : null}
                          {toolType === 'blocks' ? <td className="p-2 text-balance">{r.embossingLeafing || '—'}</td> : null}
                          {toolType === 'shade_cards' ? (
                            <>
                              <td className="p-2 whitespace-nowrap">{r.approvalDate || '—'}</td>
                              <td className="p-2 font-mono text-[11px]">{r.masterArtworkRef || '—'}</td>
                            </>
                          ) : null}
                          <td className="p-2">
                            <div className="flex flex-wrap gap-0.5">
                              {PIPELINE.map((st) => (
                                <VendorPill key={st} stage={st} active={r.vendorStage} />
                              ))}
                            </div>
                          </td>
                          {toolType === 'dies' ? (
                            <td className="p-2">
                              <button
                                type="button"
                                onClick={() => void sharpen(r.id)}
                                className="px-2 py-0.5 rounded bg-amber-800/90 hover:bg-amber-700 text-[10px] font-semibold text-balance"
                              >
                                Sharpening
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {toolType === 'blocks' ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3 space-y-2">
              <h3 className="text-xs font-semibold text-slate-300">Block condition (inventory)</h3>
              <select
                value={blockPick}
                onChange={(e) => setBlockPick(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-sm"
              >
                <option value="">Select block…</option>
                {embossBlocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.blockCode} — {b.condition}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                {(['Perfect', 'Worn Out', 'Needs Replacement'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setBlockCond(c)}
                    className={`px-2 py-1 rounded text-[11px] border ${
                      blockCond === c
                        ? 'bg-violet-700 border-violet-500 text-white'
                        : 'bg-slate-800 border-slate-600 text-slate-300'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void saveBlockCondition()}
                className="px-3 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 text-xs font-medium"
              >
                Save condition
              </button>
            </div>
          ) : null}
        </section>

        {/* Zone 2 — Procurement */}
        <section
          id="die-procurement"
          className="min-h-0 overflow-y-auto p-4 border-b xl:border-b-0 border-slate-800 scroll-mt-28"
        >
          <h2 className="text-sm font-semibold text-amber-200/95 uppercase tracking-wide mb-2">2 · Procurement</h2>
          <p className="text-[11px] text-slate-500 mb-3">Vendor orders and physical sample gates.</p>
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="text-sm text-slate-500">No open requirements.</p>
            ) : (
              rows.map((r) => (
                <div
                  key={`proc-${r.id}`}
                  className="rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-[11px] space-y-2"
                >
                  <div className="font-mono text-cyan-300">{r.code}</div>
                  <div className="text-slate-200 font-medium">{r.title}</div>
                  <div className="flex flex-wrap gap-0.5">
                    {PIPELINE.map((st) => (
                      <VendorPill key={st} stage={st} active={r.vendorStage} />
                    ))}
                  </div>
                  {toolType === 'shade_cards' && r.physicalSampleAwaiting ? (
                    <div className="rounded border border-amber-600/50 bg-amber-950/40 px-2 py-1 text-amber-200/95">
                      Physical sample awaiting
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {toolType === 'dies' ? (
            <p className="mt-4 text-[11px] text-slate-500">
              No in-house die-making — use <span className="text-amber-400">Send to vendor</span> for procurement.
            </p>
          ) : null}
        </section>

        {/* Zone 3 — Live inventory (rack) */}
        <section
          id="die-live-rack"
          className="min-h-0 overflow-y-auto p-4 border-b xl:border-b-0 border-slate-800 scroll-mt-28"
        >
          <h2 className="text-sm font-semibold text-amber-200/95 uppercase tracking-wide mb-2">
            3 · Live inventory (rack)
          </h2>
          <label className="block text-[11px] text-slate-400 mb-2">
            Search
            <input
              value={invSearch}
              onChange={(e) => setInvSearch(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-sm text-white placeholder:text-slate-500"
              placeholder={toolType === 'shade_cards' ? 'Slot, ref, master artwork…' : 'Block code, condition…'}
            />
          </label>
          {toolType === 'shade_cards' ? (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.min(RACK_COLS, 6)}, minmax(0, 1fr))` }}
            >
              {inventoryFiltered.map((s) => (
                <div
                  key={s.slot}
                  className="rounded-lg border border-slate-600 bg-slate-900 overflow-hidden flex flex-col"
                >
                  <div className="aspect-square relative bg-gradient-to-br from-amber-900/40 to-violet-900/40 flex items-center justify-center">
                    <span className="text-[10px] text-slate-500 px-1 text-center text-balance">
                      {s.previewUrl ? 'Image URL configured' : 'Colour preview'}
                    </span>
                  </div>
                  <div className="p-2 text-[10px] space-y-0.5">
                    <div className="font-mono text-cyan-300">{s.ref}</div>
                    <div className="text-slate-400">Slot {s.slot}</div>
                    <div className="text-emerald-400/90">{s.holder}</div>
                    <div className="text-slate-500">
                      Approval: <span className="text-slate-300">{s.approvalDate || '—'}</span>
                    </div>
                    <div className="text-slate-500">
                      Master artwork:{' '}
                      <span className="font-mono text-violet-300/95">{s.masterArtworkRef || '—'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : toolType === 'blocks' ? (
            <ul className="space-y-1.5 text-[11px]">
              {inventoryFiltered.length === 0 ? (
                <li className="text-slate-500">No blocks match search.</li>
              ) : (
                inventoryFiltered.map((b) => (
                  <li
                    key={b.id}
                    className="rounded-lg border border-slate-700 bg-slate-900/80 px-2 py-1.5 flex justify-between gap-2"
                  >
                    <span className="font-mono text-cyan-300">{b.blockCode}</span>
                    <span className="text-slate-400">{b.condition}</span>
                  </li>
                ))
              )}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">
              Storage ties to physical layout. Open{' '}
              <Link href="/masters/dies/location-view" className="text-amber-400 hover:underline">
                location view
              </Link>{' '}
              for the full map; search above filters known die records when connected.
            </p>
          )}
        </section>

        {/* Zone 4 — Custody (floor) */}
        <section className="min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-amber-200/95 uppercase tracking-wide">4 · Custody (floor)</h2>
          {toolType === 'shade_cards' ? (
            <p className="text-[11px] text-slate-500">Machine custody and ink-lab checkouts.</p>
          ) : (
            <p className="text-[11px] text-slate-500">
              Return to rack logs impression wear — use <span className="text-emerald-400">Return to rack</span> below.
            </p>
          )}
          <div className="rounded-xl border border-slate-700 overflow-hidden">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-slate-800/80 text-slate-400 uppercase">
                <tr>
                  <th className="p-2 w-8">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="p-2">Tool</th>
                  <th className="p-2">Machine ID</th>
                  <th className="p-2">Operator</th>
                  <th className="p-2">Time out</th>
                </tr>
              </thead>
              <tbody>
                {custodyRows.map((c) => {
                  const t = new Date(c.timeOutAt)
                  const rel = Number.isNaN(t.getTime()) ? '—' : formatDistanceToNow(t, { addSuffix: true })
                  return (
                    <tr key={c.id} className="border-t border-slate-800">
                      <td className="p-2 align-middle">
                        <input
                          type="checkbox"
                          className="rounded border-slate-600"
                          checked={selectedCustodyIds.includes(c.id)}
                          onChange={() => toggleCustodySelect(c.id)}
                          aria-label={`Select ${c.toolCode}`}
                        />
                      </td>
                      <td className="p-2 font-mono text-cyan-300">{c.toolCode}</td>
                      <td className="p-2">{c.machineId}</td>
                      <td className="p-2">{c.operator}</td>
                      <td className="p-2 text-slate-300 whitespace-nowrap" title={c.timeOutAt}>
                        {rel}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {toolType === 'shade_cards' ? (
            <ul className="space-y-2 text-sm">
              <li className="rounded-lg border border-slate-700 bg-slate-900/80 p-3">
                <span className="text-slate-400 text-xs">Ink Lab</span>
                <p className="text-slate-100">SC-DEMO-1 · awaiting spectro check</p>
              </li>
              <li className="rounded-lg border border-slate-700 bg-slate-900/80 p-3">
                <span className="text-slate-400 text-xs">Machine 1</span>
                <p className="text-slate-100">SC-DEMO-2 · on-press reference</p>
              </li>
            </ul>
          ) : (
            <button
              type="button"
              disabled={selectedCustodyIds.length === 0}
              onClick={() => setReturnOpen(true)}
              className="px-3 py-2 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-sm w-full text-left disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Return selected to rack…
              {selectedCustodyIds.length > 0 ? ` (${selectedCustodyIds.length})` : ''}
            </button>
          )}
        </section>
      </div>

      {returnOpen && toolType !== 'shade_cards' ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-slate-900 border border-slate-600 rounded-xl p-4 max-w-md w-full shadow-xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-2">Return to rack</h3>
            <p className="text-[11px] text-slate-500 mb-3">
              Applies to all selected rows. Job card and artwork IDs are mandatory for audit.
            </p>
            <div className="block text-slate-400 mb-3 text-sm">
              <span className="block text-[11px] mb-1">Condition</span>
              <div className="flex flex-wrap gap-1.5">
                {(['Good', 'Damaged', 'Needs Repair'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setReturnToolCondition(c)}
                    className={`px-2 py-1 rounded text-[11px] border ${
                      returnToolCondition === c
                        ? 'bg-emerald-800 border-emerald-500 text-white'
                        : 'bg-slate-800 border-slate-600 text-slate-300'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-sm text-slate-400 mb-2">
              Final impression count
              <input
                type="number"
                min={0}
                value={returnImpressions}
                onChange={(e) =>
                  setReturnImpressions(e.target.value === '' ? '' : Number(e.target.value))
                }
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </label>
            <label className="block text-sm text-slate-400 mb-2">
              Rack slot
              <input
                value={returnRack}
                onChange={(e) => setReturnRack(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                placeholder="e.g. D-4"
              />
            </label>
            <label className="block text-sm text-slate-400 mb-2">
              Job card ID
              <input
                value={returnJobCardId}
                onChange={(e) => setReturnJobCardId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white font-mono text-xs"
              />
            </label>
            <label className="block text-sm text-slate-400 mb-2">
              Artwork ID
              <input
                value={returnArtworkId}
                onChange={(e) => setReturnArtworkId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white font-mono text-xs"
              />
            </label>
            <label className="block text-sm text-slate-400 mb-4">
              Set #
              <input
                value={returnSetNumber}
                onChange={(e) => setReturnSetNumber(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white font-mono text-xs"
                placeholder="e.g. 01"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReturnOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitHubReturn()}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-sm font-medium"
              >
                Confirm return
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
