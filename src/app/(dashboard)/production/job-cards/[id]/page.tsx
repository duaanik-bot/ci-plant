'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { getPostPressRouting, isEmbossingRequired } from '@/lib/emboss-conditions'

type Stage = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  completedAt: string | null
}

type CartonSpecs = {
  id?: string
  artworkCode?: string | null
  coatingType: string | null
  laminateType: string | null
  foilType: string | null
  embossingLeafing: string | null
  embossBlockId: string | null
} | null

type PoLine = {
  id: string
  cartonId: string | null
  cartonName: string
  cartonSize: string | null
  quantity: number
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
  gsm: number | null
  dyeId: string | null
  po: { poNumber: string }
  carton: CartonSpecs
} | null

export type PostPressRouting = {
  chemicalCoating?: boolean
  lamination?: boolean
  spotUv?: boolean
  leafing?: boolean
  embossing?: boolean
}

type JobCard = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  customer: { id: string; name: string }
  requiredSheets: number
  wastageSheets: number
  totalSheets: number
  sheetsIssued: number
  assignedOperator: string | null
  shiftOperator?: { id: string; name: string } | null
  batchNumber: string | null
  status: string
  artworkApproved: boolean
  firstArticlePass: boolean
  finalQcPass: boolean
  qaReleased: boolean
  postPressRouting: PostPressRouting | null
  plateSetId: string | null
  embossBlockId: string | null
  stages: Stage[]
  poLine: PoLine
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'border-slate-700 text-slate-300',
  ready: 'border-amber-600 text-amber-200',
  in_progress: 'border-blue-600 text-blue-200',
  completed: 'border-green-600 text-green-200',
}

const POST_PRESS_KEYS: { key: keyof PostPressRouting; label: string; hint: string }[] = [
  { key: 'chemicalCoating', label: 'Chemical Coating', hint: 'Required if coating = Aqueous Varnish or Chemical Coating' },
  { key: 'lamination', label: 'Lamination', hint: 'Required if laminate type ≠ None' },
  { key: 'spotUv', label: 'Spot UV', hint: 'Required if coating contains UV' },
  { key: 'leafing', label: 'Leafing/Foiling', hint: 'Required if foil type ≠ None' },
  { key: 'embossing', label: 'Embossing', hint: 'Required if embossing/leafing ≠ None' },
]

function suggestPostPressRouting(poLine: PoLine): PostPressRouting {
  if (!poLine) return {}
  const carton = poLine.carton
  const routing = getPostPressRouting({
    embossingLeafing: carton?.embossingLeafing ?? poLine.embossingLeafing,
    coatingType: carton?.coatingType ?? poLine.coatingType,
    laminateType: carton?.laminateType ?? null,
  })
  const foil = (carton?.foilType ?? '').toLowerCase()
  return {
    chemicalCoating: routing.needsChemicalCoating,
    lamination: routing.needsLamination,
    spotUv: routing.needsSpotUv,
    leafing: foil !== '' && foil !== 'none',
    embossing: routing.needsEmbossing,
  }
}

export default function JobCardDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [jc, setJc] = useState<JobCard | null>(null)
  const [shiftOperators, setShiftOperators] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [artworkVersion, setArtworkVersion] = useState('R0')
  const [plateCheck, setPlateCheck] = useState<{
    status: 'all_new' | 'all_available' | 'partial'
    plateSetCode: string | null
    message: string
    newNeeded: number
    oldAvailable: number
  } | null>(null)
  const [dyeDetail, setDyeDetail] = useState<{
    dyeNumber: number
    condition: string
    impressionCount: number
    maxImpressions: number
    active: boolean
  } | null | 'unavailable'>(null)
  const [embossDetail, setEmbossDetail] = useState<{
    blockCode: string
    condition: string
    impressionCount: number
    maxImpressions: number
    active: boolean
  } | null | 'unavailable'>(null)
  const [dieStoreCheck, setDieStoreCheck] = useState<{
    status: 'available' | 'needs_attention' | 'end_of_life' | 'not_available'
    message: string
    dieCode?: string
    dieNumber?: number | null
    lifeRemaining?: number
  } | null>(null)
  const [platesReturned, setPlatesReturned] = useState(false)
  const [dieReturned, setDieReturned] = useState(false)
  const [embossReturned, setEmbossReturned] = useState(false)

  useEffect(() => {
    fetch(`/api/job-cards/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setJc(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((list) => setShiftOperators(Array.isArray(list) ? list : []))
      .catch(() => setShiftOperators([]))
  }, [])

  const cartonId = jc?.poLine?.cartonId ?? jc?.poLine?.carton?.id ?? null
  const embossBlockId = jc?.embossBlockId ?? jc?.poLine?.carton?.embossBlockId ?? null
  const embossRequired = isEmbossingRequired(jc?.poLine?.carton?.embossingLeafing ?? jc?.poLine?.embossingLeafing)

  useEffect(() => {
    if (!cartonId || !artworkVersion.trim()) {
      setPlateCheck(null)
      return
    }
    const artworkCode = (jc?.poLine?.carton?.artworkCode || jc?.poLine?.cartonName || '').trim()
    fetch(`/api/plate-store/check?${new URLSearchParams({ cartonId, artworkCode, artworkVersion: artworkVersion.trim() })}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setPlateCheck(data)
      })
      .catch(() => setPlateCheck(null))
  }, [cartonId, artworkVersion, jc?.poLine?.carton?.artworkCode, jc?.poLine?.cartonName])

  useEffect(() => {
    const dyeId = jc?.poLine?.dyeId ?? null
    if (!dyeId) {
      setDyeDetail(null)
      return
    }
    fetch(`/api/masters/dyes/${dyeId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setDyeDetail({
          dyeNumber: data.dyeNumber,
          condition: data.condition ?? data.conditionRating ?? 'Good',
          impressionCount: data.impressionCount ?? 0,
          maxImpressions: data.maxImpressions ?? 500000,
          active: data.active !== false,
        })
      })
      .catch(() => setDyeDetail(null))
  }, [jc?.poLine?.dyeId])

  useEffect(() => {
    if (!jc?.poLine) {
      setDieStoreCheck(null)
      return
    }
    fetch(`/api/die-store/check?${new URLSearchParams({
      cartonId: cartonId ?? '',
      cartonSize: jc.poLine.cartonSize ?? '',
      dieType: 'BSO',
      ups: '1',
      sheetSize: '',
    })}`)
      .then((r) => r.json())
      .then((data) => setDieStoreCheck(data))
      .catch(() => setDieStoreCheck(null))
  }, [cartonId, jc?.poLine?.cartonSize, jc?.poLine])

  useEffect(() => {
    if (!embossBlockId) {
      setEmbossDetail(null)
      return
    }
    fetch(`/api/masters/emboss-blocks/${embossBlockId}`)
      .then((r) => {
        if (!r.ok) throw new Error('Unavailable')
        return r.json()
      })
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setEmbossDetail({
          blockCode: data.blockCode,
          condition: data.condition ?? 'Good',
          impressionCount: data.impressionCount ?? 0,
          maxImpressions: data.maxImpressions ?? 100000,
          active: data.active !== false,
        })
      })
      .catch(() => setEmbossDetail('unavailable'))
  }, [embossBlockId])

  const stageByLabel = useMemo(() => {
    const map = new Map<string, Stage>()
    ;(jc?.stages || []).forEach((s) => map.set(s.stageName, s))
    return map
  }, [jc])

  const update = <K extends keyof JobCard>(key: K, value: JobCard[K]) => {
    setJc((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const updateStage = (stageId: string, patch: Partial<Stage>) => {
    setJc((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        stages: prev.stages.map((s) => (s.id === stageId ? { ...s, ...patch } : s)),
      }
    })
  }

  async function saveChanges(payload: any) {
    if (!jc) return
    setSaving(true)
    try {
      const res = await fetch(`/api/job-cards/${jc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Updated')
      // refresh
      const refreshed = await fetch(`/api/job-cards/${jc.id}`).then((r) => r.json())
      setJc(refreshed)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (!jc) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-amber-400">
            Job Card #{jc.jobCardNumber}
          </h1>
          <p className="text-sm text-slate-400">
            {jc.customer.name}
            {jc.setNumber ? ` · Set ${jc.setNumber}` : ''}{' '}
            {jc.batchNumber ? ` · Batch ${jc.batchNumber}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => router.push('/production/job-cards')}
            className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
          >
            Back
          </button>
          <a
            href={`/api/job-cards/${jc.id}/card-pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
          >
            Job Card PDF
          </a>
          {jc.poLine && (
            <a
              href={`/api/designing/po-lines/${jc.poLine.id}/job-spec-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
            >
              Job Spec PDF
            </a>
          )}
          {jc.poLine && (
            <Link
              href={`/orders/designing/${jc.poLine.id}`}
              className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
            >
              Designing
            </Link>
          )}
          <Link
            href={`/stores/issue?jobCardId=${jc.id}`}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
          >
            Issue sheets
          </Link>
        </div>
      </div>

      {jc.poLine && (
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-2">Specs (from PO line)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm text-slate-300">
            <div><span className="text-slate-500">PO</span> {jc.poLine.po.poNumber}</div>
            <div><span className="text-slate-500">Carton</span> {jc.poLine.cartonName}</div>
            <div><span className="text-slate-500">Size</span> {jc.poLine.cartonSize ?? '—'}</div>
            <div><span className="text-slate-500">Qty</span> {jc.poLine.quantity}</div>
            <div><span className="text-slate-500">Paper</span> {jc.poLine.paperType ?? '—'}</div>
            <div><span className="text-slate-500">Coating</span> {jc.poLine.coatingType ?? '—'}</div>
            <div><span className="text-slate-500">Emboss/Leaf</span> {jc.poLine.embossingLeafing ?? '—'}</div>
            <div><span className="text-slate-500">GSM</span> {jc.poLine.gsm ?? '—'}</div>
          </div>
        </div>
      )}

      <div className="rounded-xl bg-black border border-zinc-800 p-4">
        <h2 className="text-sm font-semibold text-orange-400 mb-2">Shift operator (attribution)</h2>
        <p className="text-xs text-zinc-500 mb-2">
          Links this job to a user for OEE / yield leaderboard and incentive eligibility on close.
        </p>
        <select
          className="w-full max-w-md px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-slate-200 text-sm font-designing-queue"
          value={jc.shiftOperator?.id ?? ''}
          disabled={saving}
          onChange={(e) =>
            saveChanges({
              shiftOperatorUserId: e.target.value ? e.target.value : null,
            })
          }
        >
          <option value="">— Unassigned —</option>
          {shiftOperators.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>

      {/* Availability: Plate, Dye, Emboss */}
      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Availability</h2>
        <div className="grid md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h3 className="text-xs font-medium text-slate-400 mb-2">Plates</h3>
            {!cartonId ? (
              <p className="text-xs text-slate-500">No carton linked to PO line</p>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <label className="text-xs text-slate-500">Artwork ver.</label>
                  <input
                    type="text"
                    value={artworkVersion}
                    onChange={(e) => setArtworkVersion(e.target.value)}
                    placeholder="R0"
                    className="w-16 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs"
                  />
                </div>
                {plateCheck === null ? (
                  <p className="text-xs text-slate-500">Checking…</p>
                ) : (
                  <div className={`rounded p-2 text-xs ${
                    plateCheck.status === 'all_available'
                      ? 'bg-green-900/20 text-green-300'
                      : plateCheck.status === 'partial'
                        ? 'bg-amber-900/20 text-amber-300'
                        : 'bg-red-900/20 text-red-300'
                  }`}>
                    <p>{plateCheck.message}</p>
                    <p>Old Available: {plateCheck.oldAvailable} | New Needed: {plateCheck.newNeeded}</p>
                    {plateCheck.plateSetCode ? <p className="font-mono">{plateCheck.plateSetCode}</p> : null}
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <Link href="/pre-press/plate-store" className="text-xs text-amber-400 hover:underline inline-block">Plate store →</Link>
                  <Link href={`/pre-press/plate-store`} className="text-xs text-blue-300 hover:underline inline-block">Issue Plates to Press</Link>
                </div>
              </>
            )}
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h3 className="text-xs font-medium text-slate-400 mb-2">Die</h3>
            {dieStoreCheck ? (
              <div className={`rounded p-2 text-xs mb-2 ${
                dieStoreCheck.status === 'available'
                  ? 'bg-green-900/20 text-green-300'
                  : dieStoreCheck.status === 'needs_attention'
                    ? 'bg-amber-900/20 text-amber-300'
                    : 'bg-red-900/20 text-red-300'
              }`}>
                <p>{dieStoreCheck.message}</p>
                {dieStoreCheck.dieCode ? <p className="font-mono">{dieStoreCheck.dieCode}{dieStoreCheck.dieNumber ? ` · No. ${dieStoreCheck.dieNumber}` : ''}</p> : null}
              </div>
            ) : null}
            {!jc?.poLine?.dyeId ? (
              <p className="text-xs text-slate-500">No dye set for this PO line</p>
            ) : dyeDetail === null ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : dyeDetail === 'unavailable' ? (
              <p className="text-xs text-slate-500">Dye assigned — details unavailable</p>
            ) : (
              <>
                <p className="text-sm font-mono text-slate-200">#{dyeDetail.dyeNumber}</p>
                <p className="text-xs text-slate-400">Condition: {dyeDetail.condition}</p>
                <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden mt-1">
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${dyeDetail.maxImpressions ? Math.min(100, (dyeDetail.impressionCount / dyeDetail.maxImpressions) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 mt-1">{dyeDetail.impressionCount.toLocaleString()} / {dyeDetail.maxImpressions.toLocaleString()} imp.</p>
                {!dyeDetail.active && <p className="text-xs text-amber-400">Inactive</p>}
                <div className="flex gap-2 mt-2">
                  <Link href={`/masters/dyes/${jc.poLine!.dyeId}`} className="text-xs text-amber-400 hover:underline inline-block">Dye detail →</Link>
                  <Link href="/masters/dies" className="text-xs text-blue-300 hover:underline inline-block">Issue/Return Die →</Link>
                </div>
              </>
            )}
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h3 className="text-xs font-medium text-slate-400 mb-2">Emboss block</h3>
            {!embossRequired ? (
              <div className="text-xs text-slate-500 border border-slate-800 rounded p-3">
                Embossing Block: Not applicable for this product
              </div>
            ) : !embossBlockId ? (
              (jc?.postPressRouting?.embossing || (jc?.poLine?.embossingLeafing && jc.poLine.embossingLeafing !== 'None')) ? (
                <p className="text-xs text-amber-400">Embossing required — block not assigned</p>
              ) : (
                <p className="text-xs text-slate-500">Not required</p>
              )
            ) : embossDetail === null ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : embossDetail === 'unavailable' ? (
              <p className="text-xs text-slate-500">Block assigned — details unavailable</p>
            ) : (
              <>
                <p className="text-sm font-mono text-slate-200">{embossDetail.blockCode}</p>
                <p className="text-xs text-slate-400">Condition: {embossDetail.condition}</p>
                <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden mt-1">
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${embossDetail.maxImpressions ? Math.min(100, (embossDetail.impressionCount / embossDetail.maxImpressions) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 mt-1">{embossDetail.impressionCount.toLocaleString()} / {embossDetail.maxImpressions.toLocaleString()} imp.</p>
                {!embossDetail.active && <p className="text-xs text-amber-400">Inactive</p>}
                <Link href={`/masters/emboss-blocks/${embossBlockId}`} className="text-xs text-amber-400 hover:underline mt-2 inline-block">Block detail →</Link>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Post-Press Routing — conditional stages */}
      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <h2 className="text-sm font-semibold text-slate-200 mb-2">Post-Press Routing — Select applicable stages</h2>
        <p className="text-xs text-slate-500 mb-3">
          After Printing, which stages apply? Toggles are auto-suggested from carton specs; you can override.
        </p>
        <div className="space-y-2">
          {POST_PRESS_KEYS.map(({ key, label, hint }) => {
            const effective = jc.postPressRouting ?? suggestPostPressRouting(jc.poLine)
            const checked = key === 'embossing' && !embossRequired ? false : (effective[key] ?? false)
            const embossBypassed = key === 'embossing' && !embossRequired
            return (
              <label
                key={key}
                className="flex items-center gap-3 py-1.5 rounded-lg px-2 hover:bg-slate-800/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={embossBypassed}
                  onChange={() => {
                    const next = { ...(jc.postPressRouting ?? suggestPostPressRouting(jc.poLine)), [key]: !checked }
                    update('postPressRouting', next)
                  }}
                  className="rounded border-slate-600 bg-slate-800 text-amber-500"
                />
                <span className={`text-sm font-medium ${embossBypassed ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{label}</span>
                <span className="text-xs text-slate-500">{embossBypassed ? 'Not applicable - Embossing not required' : hint}</span>
              </label>
            )
          })}
        </div>
        <button
          disabled={saving}
          onClick={() =>
            saveChanges({
              postPressRouting: jc.postPressRouting ?? suggestPostPressRouting(jc.poLine),
            })
          }
          className="mt-3 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium"
        >
          {saving ? 'Saving…' : 'Save post-press routing'}
        </button>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <h2 className="text-sm font-semibold text-slate-200 mb-2">Sheet calc</h2>
        <div className="flex flex-wrap gap-6 text-sm">
          <div><span className="text-slate-500">Required</span> <span className="text-slate-200 font-mono">{jc.requiredSheets}</span></div>
          <div><span className="text-slate-500">Wastage</span> <span className="text-slate-200 font-mono">{jc.wastageSheets}</span></div>
          <div><span className="text-slate-500">Total</span> <span className="text-amber-300 font-mono">{jc.totalSheets}</span></div>
          <div><span className="text-slate-500">Issued</span> <span className="text-slate-200 font-mono">{jc.sheetsIssued}</span></div>
        </div>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Tools Issued for This Job</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-2">Tool</th>
                <th className="text-left py-2">Code</th>
                <th className="text-left py-2">Location</th>
                <th className="text-left py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              <tr>
                <td className="py-2 text-slate-300">Plates</td>
                <td className="py-2 font-mono text-slate-200">{plateCheck?.plateSetCode || '-'}</td>
                <td className="py-2 text-slate-400">Rack B-1</td>
                <td className="py-2">
                  <Link href="/pre-press/plate-store" className="text-blue-300 hover:underline mr-3">Issue</Link>
                  <Link href="/pre-press/plate-store" className="text-amber-300 hover:underline">View</Link>
                </td>
              </tr>
              <tr>
                <td className="py-2 text-slate-300">Die</td>
                <td className="py-2 font-mono text-slate-200">{dieStoreCheck?.dieCode || '-'}</td>
                <td className="py-2 text-slate-400">Rack A-1</td>
                <td className="py-2">
                  <Link href="/masters/dies" className="text-blue-300 hover:underline mr-3">Issue</Link>
                  <Link href="/masters/dies" className="text-amber-300 hover:underline">View</Link>
                </td>
              </tr>
              <tr>
                <td className="py-2 text-slate-300">Emb. Block</td>
                <td className="py-2 font-mono text-slate-200">{embossRequired ? embossDetail && embossDetail !== 'unavailable' ? embossDetail.blockCode : '-' : 'N/A'}</td>
                <td className="py-2 text-slate-400">Rack C-1</td>
                <td className="py-2">
                  <Link href="/masters/emboss-blocks" className="text-blue-300 hover:underline mr-3">Issue</Link>
                  <Link href="/masters/emboss-blocks" className="text-amber-300 hover:underline">View</Link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <h2 className="text-sm font-semibold text-slate-200 mb-2">Return All Tools</h2>
        <p className="text-xs text-slate-500 mb-3">All tools must be returned before job can be closed.</p>
        <div className="space-y-2 text-sm mb-3">
          <label className="flex items-center gap-2 text-slate-300"><input type="checkbox" checked={platesReturned} onChange={(e) => setPlatesReturned(e.target.checked)} /> Plates returned to rack</label>
          <label className="flex items-center gap-2 text-slate-300"><input type="checkbox" checked={dieReturned} onChange={(e) => setDieReturned(e.target.checked)} /> Die returned to location</label>
          {embossRequired ? <label className="flex items-center gap-2 text-slate-300"><input type="checkbox" checked={embossReturned} onChange={(e) => setEmbossReturned(e.target.checked)} /> Emboss block returned</label> : null}
        </div>
        <button
          type="button"
          disabled={!platesReturned || !dieReturned || (embossRequired && !embossReturned)}
          onClick={() => saveChanges({ status: 'closed' })}
          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-xs"
        >
          Mark Job Complete
        </button>
      </div>

      {/* Header controls */}
      <div className="grid md:grid-cols-4 gap-3 bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Assigned operator</label>
          <input
            type="text"
            value={jc.assignedOperator ?? ''}
            onChange={(e) => update('assignedOperator', e.target.value || null)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Batch number</label>
          <input
            type="text"
            value={jc.batchNumber ?? ''}
            onChange={(e) => update('batchNumber', e.target.value || null)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Required sheets</label>
          <input
            type="number"
            min={1}
            value={jc.requiredSheets}
            onChange={(e) => update('requiredSheets', Number(e.target.value) || jc.requiredSheets)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Wastage sheets</label>
          <input
            type="number"
            min={0}
            value={jc.wastageSheets}
            onChange={(e) => update('wastageSheets', Number(e.target.value) || 0)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>

        <div className="md:col-span-4 pt-2">
          <p className="text-slate-400 text-xs mb-2">Compliance checklist</p>
          <div className="flex flex-wrap gap-4 text-xs">
            {[
              { key: 'artworkApproved', label: 'Artwork approved' },
              { key: 'firstArticlePass', label: 'First article pass' },
              { key: 'finalQcPass', label: 'Final QC pass' },
              { key: 'qaReleased', label: 'QA released' },
            ].map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-slate-200">
                <input
                  type="checkbox"
                  checked={(jc as any)[f.key] as boolean}
                  onChange={(e) => update(f.key as keyof JobCard, e.target.checked)}
                  className="rounded border-slate-600 bg-slate-800"
                />
                {f.label}
              </label>
            ))}
          </div>
          <button
            disabled={saving}
            onClick={() =>
              saveChanges({
                assignedOperator: jc.assignedOperator,
                batchNumber: jc.batchNumber,
                requiredSheets: jc.requiredSheets,
                wastageSheets: jc.wastageSheets,
                artworkApproved: jc.artworkApproved,
                firstArticlePass: jc.firstArticlePass,
                finalQcPass: jc.finalQcPass,
                qaReleased: jc.qaReleased,
              })
            }
            className="ml-auto px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium"
          >
            {saving ? 'Saving…' : 'Save header'}
          </button>
        </div>
      </div>

      {/* Stage tiles */}
      <div className="grid md:grid-cols-3 gap-3">
        {PRODUCTION_STAGES.map((s) => {
          const stage = stageByLabel.get(s.label)
          if (!stage) {
            return (
              <div
                key={s.key}
                className="rounded-lg border border-slate-700 bg-slate-900 p-3"
              >
                <p className="text-sm font-semibold text-slate-200">{s.label}</p>
                <p className="text-xs text-slate-500 mt-1">Not created</p>
              </div>
            )
          }
          const cls = STATUS_COLORS[stage.status] ?? STATUS_COLORS.pending
          return (
            <div
              key={stage.id}
              className="rounded-lg border bg-slate-900 p-3 border-slate-700"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-200">{stage.stageName}</p>
                <span className={`px-2 py-0.5 rounded text-xs border ${cls}`}>
                  {stage.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                <div>
                  <label className="block text-slate-500 mb-1">Operator</label>
                  <input
                    type="text"
                    value={stage.operator ?? ''}
                    onChange={(e) =>
                      updateStage(stage.id, { operator: e.target.value || null })
                    }
                    className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Counter</label>
                  <input
                    type="number"
                    value={stage.counter ?? ''}
                    onChange={(e) =>
                      updateStage(stage.id, {
                        counter: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-slate-500 mb-1">Sheet size</label>
                  <input
                    type="text"
                    value={stage.sheetSize ?? ''}
                    onChange={(e) =>
                      updateStage(stage.id, { sheetSize: e.target.value || null })
                    }
                    className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white"
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-3">
                <button
                  disabled={saving}
                  onClick={() =>
                    saveChanges({
                      stages: [
                        {
                          id: stage.id,
                          status: stage.status === 'in_progress' ? 'completed' : 'in_progress',
                          operator: stage.operator,
                          counter: stage.counter,
                          sheetSize: stage.sheetSize,
                        },
                      ],
                    })
                  }
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs disabled:opacity-50"
                >
                  {stage.status === 'in_progress' ? 'Mark completed' : 'Start stage'}
                </button>
                <button
                  disabled={saving}
                  onClick={() =>
                    saveChanges({
                      stages: [
                        {
                          id: stage.id,
                          status: 'pending',
                          operator: stage.operator,
                          counter: stage.counter,
                          sheetSize: stage.sheetSize,
                        },
                      ],
                    })
                  }
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-xs disabled:opacity-50"
                >
                  Reset
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

