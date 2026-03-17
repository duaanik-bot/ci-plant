'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'

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
  const coating = (carton?.coatingType ?? poLine.coatingType ?? '').toLowerCase()
  const laminate = (carton?.laminateType ?? '').toLowerCase()
  const foil = (carton?.foilType ?? '').toLowerCase()
  const emboss = (carton?.embossingLeafing ?? poLine.embossingLeafing ?? '').toLowerCase()
  return {
    chemicalCoating: coating.includes('aqueous') || coating.includes('chemical coating'),
    lamination: laminate !== '' && laminate !== 'none',
    spotUv: coating.includes('uv'),
    leafing: foil !== '' && foil !== 'none',
    embossing: emboss !== '' && emboss !== 'none',
  }
}

export default function JobCardDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [jc, setJc] = useState<JobCard | null>(null)
  const [saving, setSaving] = useState(false)
  const [artworkVersion, setArtworkVersion] = useState('R0')
  const [plateCheck, setPlateCheck] = useState<{
    hasPlates: boolean
    plates: { plateSetCode: string; status: string; allAvailable: boolean }[]
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

  useEffect(() => {
    fetch(`/api/job-cards/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setJc(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  const cartonId = jc?.poLine?.cartonId ?? jc?.poLine?.carton?.id ?? null
  const embossBlockId = jc?.embossBlockId ?? jc?.poLine?.carton?.embossBlockId ?? null

  useEffect(() => {
    if (!cartonId || !artworkVersion.trim()) {
      setPlateCheck(null)
      return
    }
    const encoded = encodeURIComponent(artworkVersion.trim())
    fetch(`/api/plate-store/check/${cartonId}/${encoded}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setPlateCheck({
          hasPlates: data.hasPlates ?? false,
          plates: (data.plates ?? []).map((p: { plateSetCode: string; status: string; allAvailable: boolean }) => ({
            plateSetCode: p.plateSetCode,
            status: p.status,
            allAvailable: p.allAvailable,
          })),
        })
      })
      .catch(() => setPlateCheck(null))
  }, [cartonId, artworkVersion])

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
                ) : !plateCheck.hasPlates ? (
                  <p className="text-xs text-amber-400">No plates found for this carton/version</p>
                ) : (
                  <ul className="space-y-1 text-xs text-slate-200">
                    {plateCheck.plates.slice(0, 3).map((p) => (
                      <li key={p.plateSetCode} className="flex items-center gap-2">
                        <span className={p.allAvailable ? 'text-green-400' : 'text-amber-400'}>{p.allAvailable ? '✓' : '○'}</span>
                        <span className="font-mono">{p.plateSetCode}</span>
                        <span className="text-slate-500">{p.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link href="/pre-press/plate-store" className="text-xs text-amber-400 hover:underline mt-2 inline-block">Plate store →</Link>
              </>
            )}
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h3 className="text-xs font-medium text-slate-400 mb-2">Dye</h3>
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
                <Link href={`/masters/dyes/${jc.poLine!.dyeId}`} className="text-xs text-amber-400 hover:underline mt-2 inline-block">Dye detail →</Link>
              </>
            )}
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h3 className="text-xs font-medium text-slate-400 mb-2">Emboss block</h3>
            {!embossBlockId ? (
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
            const checked = effective[key] ?? false
            return (
              <label
                key={key}
                className="flex items-center gap-3 py-1.5 rounded-lg px-2 hover:bg-slate-800/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = { ...(jc.postPressRouting ?? suggestPostPressRouting(jc.poLine)), [key]: !checked }
                    update('postPressRouting', next)
                  }}
                  className="rounded border-slate-600 bg-slate-800 text-amber-500"
                />
                <span className="text-sm text-slate-200 font-medium">{label}</span>
                <span className="text-xs text-slate-500">{hint}</span>
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

