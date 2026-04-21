'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, Package } from 'lucide-react'
import clsx from 'clsx'
import { toast } from 'sonner'
import {
  AW_PO_STATUS,
  AW_PUSH_MODE,
  batchProgressSegments,
  currentRunBatches,
  readAwPoStatus,
  readPartialLedger,
  readPushMode,
  remainingBatchBalance,
  totalContractBatches,
} from '@/lib/aw-queue-spec'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type InventoryHandshake = {
  targetSheetSize: string | null
  inStockSheetSize: string | null
  grainDirection: string | null
  paperWarehouseId: string | null
  lotNumber: string | null
  grainFitStatus: string | null
  matchHint: string
}

type Props = {
  poLineId: string
  /** Current specOverrides (read-only for display); saves merge via planning PATCH */
  spec: Record<string, unknown>
  jobType: 'new' | 'repeat'
  jobCardId: string | null
  customerName: string
  productName: string
  poNumber: string
  planningStatus: string
  onReload: () => void
}

export function AwQueueCommandPanel({
  poLineId,
  spec,
  jobType,
  jobCardId,
  customerName,
  productName,
  poNumber,
  planningStatus,
  onReload,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [inv, setInv] = useState<InventoryHandshake | null>(null)

  const awPo = readAwPoStatus(spec)
  const pushMode = readPushMode(spec)
  const totalB = totalContractBatches(spec)
  const runB = currentRunBatches(spec)
  const balance = remainingBatchBalance(spec)
  const ledger = readPartialLedger(spec)
  const partialStatus = (spec.awPartialShipmentStatus as string | undefined) ?? null

  const segs = useMemo(() => batchProgressSegments(spec), [spec])

  const persistSpecPatch = useCallback(
    async (patch: Record<string, unknown>) => {
      setBusy('save')
      try {
        const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides: { ...spec, ...patch } }),
        })
        const j = (await res.json()) as { error?: string }
        if (!res.ok) throw new Error(j.error || 'Save failed')
        toast.success('Saved')
        onReload()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Save failed')
      } finally {
        setBusy(null)
      }
    },
    [poLineId, spec, onReload],
  )

  const postLifecycle = async (action: 'manual_close' | 'force_reopen') => {
    setBusy(action)
    try {
      const res = await fetch(`/api/designing/po-lines/${poLineId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const j = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Failed')
      toast.success(action === 'manual_close' ? 'Line closed — tooling released where applicable' : 'Line reopened from snapshot')
      onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  const logPartialPush = async () => {
    const n = window.prompt('Batches in this push (integer)', '1')
    if (n == null) return
    const add = Number.parseInt(n, 10)
    if (!Number.isFinite(add) || add < 1) {
      toast.error('Enter a positive integer')
      return
    }
    setBusy('partial')
    try {
      const res = await fetch(`/api/designing/po-lines/${poLineId}/partial-push-ledger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addBatches: add, jobCardId: jobCardId || null }),
      })
      const j = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Log failed')
      toast.success('Partial push logged')
      onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Log failed')
    } finally {
      setBusy(null)
    }
  }

  const applyInventoryToJobCard = async () => {
    if (!jobCardId) {
      toast.error('No job card linked — generate job card first')
      return
    }
    setBusy('inv')
    try {
      const res = await fetch(`/api/designing/po-lines/${poLineId}/inventory-handshake/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId }),
      })
      const j = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Apply failed')
      toast.success('Job card updated with warehouse batch / dimensions')
      onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(`/api/designing/po-lines/${poLineId}/inventory-handshake`)
        const j = (await r.json()) as InventoryHandshake & { error?: string }
        if (!r.ok) throw new Error(j.error || 'Handshake fetch failed')
        if (!cancelled) setInv(j)
      } catch {
        if (!cancelled) setInv(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [poLineId, spec.actualSheetSize])

  const closed = awPo === AW_PO_STATUS.CLOSED

  return (
    <div className="border-b border-slate-800 bg-background px-3 py-2">
      <div className="max-w-7xl mx-auto w-full space-y-2">
        <div
          className={clsx(
            'flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between rounded-lg border px-2.5 py-2',
            closed ? 'border-slate-700 bg-slate-950/50 opacity-80' : 'border-slate-800 bg-background',
          )}
        >
          <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-slate-500 font-sans">Client</span>
            <span className="text-slate-200 font-medium truncate max-w-[14rem]">{customerName}</span>
            <span className="text-slate-600 hidden sm:inline">·</span>
            <span className="text-slate-500 font-sans">Product</span>
            <span className="text-amber-200/90 truncate max-w-[18rem]">{productName}</span>
            <span className="text-slate-600 hidden sm:inline">·</span>
            <span className="text-slate-500 font-sans">PO</span>
            <span className={`text-slate-100 ${mono}`}>{poNumber}</span>
            <span className="text-slate-600 hidden sm:inline">·</span>
            <span className="text-slate-500 font-sans">Planning</span>
            <span className={`text-slate-300 ${mono}`}>{planningStatus}</span>
            <span
              className={clsx(
                'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1',
                awPo === AW_PO_STATUS.OPEN && 'bg-emerald-950/40 text-emerald-300 ring-emerald-500/40',
                awPo === AW_PO_STATUS.CLOSED && 'bg-slate-800 text-slate-400 ring-slate-600',
                awPo === AW_PO_STATUS.REOPENED && 'bg-orange-950/50 text-orange-200 ring-orange-500/50',
              )}
            >
              PO {awPo}
            </span>
            {partialStatus === 'partially_sent' ? (
              <span className="rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200 ring-1 ring-amber-600/40">
                Partially sent
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!!busy || closed}
              onClick={() => void postLifecycle('manual_close')}
              className="rounded-md bg-slate-600 px-2.5 py-1 text-[10px] font-semibold text-foreground hover:bg-slate-500 disabled:opacity-40"
            >
              {busy === 'manual_close' ? '…' : 'Manual close'}
            </button>
            <button
              type="button"
              disabled={!!busy || jobType !== 'repeat' || awPo !== AW_PO_STATUS.CLOSED}
              onClick={() => void postLifecycle('force_reopen')}
              className="rounded-md bg-orange-600 px-2.5 py-1 text-[10px] font-semibold text-foreground hover:bg-orange-500 disabled:opacity-40"
            >
              {busy === 'force_reopen' ? '…' : 'Force reopen'}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Batch progress
            </span>
            <span className={`text-[10px] text-slate-500 ${mono}`}>
              {totalB > 0 ? `${runB} / ${totalB} runs · ${balance} remaining` : 'Set contract total to track'}
            </span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-900 ring-1 ring-slate-800">
            <div
              className="h-full bg-emerald-600/90 transition-[width]"
              style={{ width: `${Math.round(segs.shippedPct * 100)}%` }}
              title="Shipped"
            />
            <div
              className="h-full bg-amber-500/90 transition-[width]"
              style={{ width: `${Math.round(segs.inProductionPct * 100)}%` }}
              title="In production"
            />
            <div
              className="h-full bg-slate-700 transition-[width]"
              style={{ width: `${Math.round(segs.remainingPct * 100)}%` }}
              title="Remaining"
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-background p-2 space-y-2">
            <p className="text-[10px] font-semibold uppercase text-slate-500">Push mode</p>
            <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
              <button
                type="button"
                disabled={!!busy || closed}
                onClick={() => void persistSpecPatch({ awPushMode: AW_PUSH_MODE.ONE_GO })}
                className={clsx(
                  'px-3 py-1.5 text-[11px] font-medium',
                  pushMode === AW_PUSH_MODE.ONE_GO
                    ? 'bg-amber-600 text-primary-foreground'
                    : 'bg-zinc-950 text-slate-400 hover:bg-zinc-900',
                )}
              >
                One-Go Push
              </button>
              <button
                type="button"
                disabled={!!busy || closed}
                onClick={() => void persistSpecPatch({ awPushMode: AW_PUSH_MODE.PARTIAL })}
                className={clsx(
                  'px-3 py-1.5 text-[11px] font-medium border-l border-slate-700',
                  pushMode === AW_PUSH_MODE.PARTIAL
                    ? 'bg-amber-600 text-primary-foreground'
                    : 'bg-zinc-950 text-slate-400 hover:bg-zinc-900',
                )}
              >
                Partial Push
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[10px] text-slate-500">
                Total contract batches
                <input
                  type="number"
                  min={0}
                  disabled={!!busy || closed}
                  defaultValue={totalB || ''}
                  key={`t-${totalB}`}
                  className={`mt-0.5 w-full rounded border border-slate-800 bg-background px-2 py-1 text-xs text-foreground ${mono}`}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? 0 : Number(e.target.value)
                    if (!Number.isFinite(v) || v < 0) return
                    void persistSpecPatch({ totalContractBatches: Math.floor(v) })
                  }}
                />
              </label>
              <label className="block text-[10px] text-slate-500">
                In production (batches)
                <input
                  type="number"
                  min={0}
                  disabled={!!busy || closed}
                  defaultValue={typeof spec.awInProductionBatches === 'number' ? spec.awInProductionBatches : ''}
                  key={`ip-${String(spec.awInProductionBatches)}`}
                  className={`mt-0.5 w-full rounded border border-slate-800 bg-background px-2 py-1 text-xs text-foreground ${mono}`}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? 0 : Number(e.target.value)
                    if (!Number.isFinite(v) || v < 0) return
                    void persistSpecPatch({ awInProductionBatches: Math.floor(v) })
                  }}
                />
              </label>
            </div>
            {pushMode === AW_PUSH_MODE.PARTIAL ? (
              <button
                type="button"
                disabled={!!busy || closed}
                onClick={() => void logPartialPush()}
                className="w-full rounded border border-amber-600/60 bg-amber-950/30 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-950/50 disabled:opacity-40"
              >
                {busy === 'partial' ? 'Logging…' : 'Log partial push'}
              </button>
            ) : null}
            <Dialog.Root open={ledgerOpen} onOpenChange={setLedgerOpen}>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-1 rounded border border-slate-700 py-1 text-[10px] text-slate-300 hover:bg-slate-900"
                >
                  Push history ({ledger.length})
                  <ChevronDown className="h-3 w-3" />
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[95] bg-background/70" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-[96] max-h-[min(70vh,28rem)] w-[min(96vw,24rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-slate-700 bg-[#0a0a0a] p-0 shadow-xl">
                  <div className="border-b border-slate-800 px-3 py-2">
                    <Dialog.Title className="text-sm font-semibold text-slate-100">Push ledger</Dialog.Title>
                    <Dialog.Description className="text-[11px] text-slate-500">
                      Timestamp · batches · job card · operator
                    </Dialog.Description>
                  </div>
                  <ul className="max-h-[50vh] overflow-auto divide-y divide-slate-800 text-[10px]">
                    {ledger.length === 0 ? (
                      <li className="px-3 py-4 text-slate-500">No entries yet.</li>
                    ) : (
                      [...ledger]
                        .slice()
                        .reverse()
                        .map((e, i) => (
                          <li key={`${e.at}-${i}`} className="px-3 py-2 space-y-0.5">
                            <div className={`text-slate-300 ${mono}`}>{e.at}</div>
                            <div className="text-slate-400">
                              <span className="text-amber-200/90">{e.batchCount}</span> batches
                              {e.jobCardNumber != null ? (
                                <span>
                                  {' '}
                                  · JC #{e.jobCardNumber}
                                </span>
                              ) : null}
                              {e.operatorName ? <span> · {e.operatorName}</span> : null}
                            </div>
                          </li>
                        ))
                    )}
                  </ul>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="w-full border-t border-slate-800 py-2 text-[11px] text-slate-400 hover:bg-slate-900"
                    >
                      Close
                    </button>
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>

          <div className="rounded-lg border border-slate-800 bg-background p-2 space-y-2">
            <p className="text-[10px] font-semibold uppercase text-slate-500 flex items-center gap-1">
              <Package className="h-3 w-3" aria-hidden />
              Material handshake
            </p>
            {inv ? (
              <div className="space-y-1 text-[10px] text-slate-400 leading-snug">
                <div>
                  <span className="text-slate-600">Target</span>{' '}
                  <span className={`text-slate-200 ${mono}`}>{inv.targetSheetSize ?? '—'}</span>
                </div>
                <div>
                  <span className="text-slate-600">In-stock</span>{' '}
                  <span className={`text-slate-200 ${mono}`}>{inv.inStockSheetSize ?? '—'}</span>
                </div>
                <div>
                  <span className="text-slate-600">Lot</span>{' '}
                  <span className={mono}>{inv.lotNumber ?? '—'}</span>
                </div>
                <p className="text-slate-500">{inv.matchHint}</p>
                <button
                  type="button"
                  disabled={!!busy || closed || !jobCardId}
                  onClick={() => void applyInventoryToJobCard()}
                  className="mt-1 w-full rounded border border-cyan-700/60 bg-cyan-950/30 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-950/50 disabled:opacity-40"
                >
                  {busy === 'inv' ? 'Applying…' : 'Apply to job card'}
                </button>
              </div>
            ) : (
              <p className="text-[10px] text-slate-600">Loading inventory match…</p>
            )}
          </div>
        </div>

        <p className="text-center text-[10px] text-slate-600 font-designing-queue">
          PO Lifecycle Managed — Tracking balance:{' '}
          <span className="text-slate-400">{balance}</span> batches.
        </p>
      </div>
    </div>
  )
}
