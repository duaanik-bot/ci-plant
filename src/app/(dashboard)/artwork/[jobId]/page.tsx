'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { LOCK_NAMES, LOCK_2_CHECKLIST } from '@/lib/artwork-logic'
import { toast } from 'sonner'
import QRCode from 'qrcode'

type Approval = {
  id: string
  lockNumber: number
  approvedAt: string
  checklistData: Record<string, boolean> | null
  comments: string | null
  rejected: boolean
  rejectionReason: string | null
}

type Artwork = {
  id: string
  versionNumber: number
  filename: string
  fileUrl: string
  status: string
  locksCompleted: number
  plateBarcode: string | null
  uploader: { name: string }
  approvals: Approval[]
}

type ArtworkData = {
  job: { id: string; jobNumber: string; productName: string; customerName: string }
  artworks: Artwork[]
  currentArtwork: Artwork | null
}

export default function ArtworkJobPage() {
  const params = useParams()
  const jobId = params.jobId as string
  const [data, setData] = useState<ArtworkData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lock2Checks, setLock2Checks] = useState<Record<string, boolean>>({})
  const [submittingLock, setSubmittingLock] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [plateBarcodeSvg, setPlateBarcodeSvg] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/artwork`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [jobId])

  useEffect(() => {
    if (data?.currentArtwork?.plateBarcode) {
      QRCode.toDataURL(data.currentArtwork.plateBarcode, { width: 280 }).then(setPlateBarcodeSvg)
    } else {
      setPlateBarcodeSvg(null)
    }
  }, [data?.currentArtwork?.plateBarcode])

  const art = data?.currentArtwork
  const lock1Done = art?.approvals?.some((a) => a.lockNumber === 1 && !a.rejected)
  const lock2Done = art?.approvals?.some((a) => a.lockNumber === 2 && !a.rejected)
  const lock3Done = art?.approvals?.some((a) => a.lockNumber === 3 && !a.rejected)
  const lock4Done = art?.locksCompleted >= 4

  const lock2AllChecked = LOCK_2_CHECKLIST.every((item) => lock2Checks[item.key] === true)

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const form = new FormData()
    form.set('file', file)
    try {
      const res = await fetch(`/api/artworks/${jobId}/upload`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) throw new Error(await res.text())
      toast.success('Artwork uploaded')
      const json = await fetch(`/api/jobs/${jobId}/artwork`).then((r) => r.json())
      setData(json)
    } catch (err) {
      toast.error('Upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function submitLock(lockNumber: 1 | 2 | 3, payload?: Record<string, unknown>) {
    if (!art) return
    setSubmittingLock(lockNumber)
    try {
      const res = await fetch(`/api/artworks/${art.id}/approve-lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lockNumber,
          checklistData: lockNumber === 2 ? lock2Checks : undefined,
          ...payload,
        }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed')
      toast.success(result.message)
      const json = await fetch(`/api/jobs/${jobId}/artwork`).then((r) => r.json())
      setData(json)
      if (lockNumber === 2) setLock2Checks({})
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmittingLock(null)
    }
  }

  if (loading || !data) {
    return (
      <div className="p-4 text-ds-ink-muted">Loading…</div>
    )
  }

  const statusBadge = art?.status === 'approved' ? 'bg-green-900/50 text-green-300' : art?.status === 'partially_approved' ? 'bg-ds-warning/12 text-ds-warning' : 'bg-ds-elevated text-ds-ink-muted'

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-6">
      <div className="bg-ds-elevated rounded-lg p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-bold text-ds-warning">{data.job.jobNumber}</h1>
            <p className="text-ds-ink-muted">{data.job.productName}</p>
            <p className="text-ds-ink-muted text-sm">{data.job.customerName}</p>
          </div>
          <span className={`px-3 py-1 rounded text-sm font-medium ${statusBadge}`}>
            {art?.status ?? 'pending'}
          </span>
        </div>
      </div>

      {art && (
        <div className="flex items-center gap-2 flex-wrap">
          {[1, 2, 3, 4].map((n) => {
            const done = n === 1 ? lock1Done : n === 2 ? lock2Done : n === 3 ? lock3Done : lock4Done
            const current = n === 1 ? !lock1Done : n === 2 ? lock1Done && !lock2Done : n === 3 ? lock2Done && !lock3Done : lock3Done && !lock4Done
            return (
              <span
                key={n}
                className={`px-3 py-1 rounded text-sm ${
                  done ? 'bg-green-700 text-primary-foreground' : current ? 'bg-blue-700 text-primary-foreground' : 'bg-ds-line/30 text-ds-ink-muted'
                }`}
              >
                Lock {n} {done ? '✓' : current ? '●' : '○'}
              </span>
            )
          })}
        </div>
      )}

      {!art && (
        <div className="bg-ds-elevated rounded-lg p-4">
          <p className="text-ds-ink-muted mb-2">No artwork yet.</p>
          <label className="inline-block px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground cursor-pointer">
            {uploading ? 'Uploading…' : 'Upload customer approval document'}
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={handleUpload}
              disabled={uploading}
            />
          </label>
        </div>
      )}

      {art && (
        <>
          {/* Lock 1 */}
          <div
            className={`rounded-lg p-4 border-2 ${
              lock1Done ? 'bg-green-900/30 border-green-600' : 'bg-ds-elevated border-ds-line/60'
            }`}
          >
            <h2 className="font-semibold mb-2">
              Lock 1: {LOCK_NAMES[1]} {lock1Done && '✓'}
            </h2>
            {lock1Done ? (
              <p className="text-green-300 text-sm">Customer doc uploaded and accepted.</p>
            ) : (
              <div className="flex items-center gap-4">
                <span className="text-red-400 text-sm">Not completed</span>
                <label className="px-3 py-1.5 rounded bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm cursor-pointer">
                  Upload document
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    className="hidden"
                    onChange={handleUpload}
                    disabled={uploading}
                  />
                </label>
              </div>
            )}
          </div>

          {/* Lock 2 */}
          <div
            className={`rounded-lg p-4 border-2 ${
              lock2Done ? 'bg-green-900/30 border-green-600' : 'bg-ds-elevated border-ds-line/60'
            }`}
          >
            <h2 className="font-semibold mb-2">
              Lock 2: {LOCK_NAMES[2]} {lock2Done && '✓'}
            </h2>
            {lock2Done ? (
              <p className="text-green-300 text-sm">Checklist completed.</p>
            ) : (
              <div className="space-y-2">
                {LOCK_2_CHECKLIST.map((item) => (
                  <label key={item.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={lock2Checks[item.key] ?? false}
                      onChange={(e) =>
                        setLock2Checks((s) => ({ ...s, [item.key]: e.target.checked }))
                      }
                      className="rounded"
                    />
                    {item.label}
                  </label>
                ))}
                <button
                  type="button"
                  disabled={!lock2AllChecked || submittingLock !== null}
                  onClick={() => submitLock(2)}
                  className="mt-2 px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 disabled:cursor-not-allowed text-primary-foreground text-sm"
                >
                  {submittingLock === 2 ? 'Submitting…' : 'Submit checklist'}
                </button>
              </div>
            )}
          </div>

          {/* Lock 3 */}
          <div
            className={`rounded-lg p-4 border-2 ${
              lock3Done ? 'bg-green-900/30 border-green-600' : 'bg-ds-elevated border-ds-line/60'
            }`}
          >
            <h2 className="font-semibold mb-2">
              Lock 3: {LOCK_NAMES[3]} {lock3Done && '✓'}
            </h2>
            {lock3Done ? (
              <p className="text-green-300 text-sm">QA Manager sign-off done.</p>
            ) : (
              <div>
                <p className="text-ds-ink-muted text-sm mb-2">Version comparison — QA Manager sign-off.</p>
                <button
                  type="button"
                  disabled={submittingLock !== null}
                  onClick={() => submitLock(3)}
                  className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 text-primary-foreground text-sm"
                >
                  {submittingLock === 3 ? 'Submitting…' : 'Sign off'}
                </button>
              </div>
            )}
          </div>

          {/* Lock 4 */}
          <div
            className={`rounded-lg p-4 border-2 ${
              lock4Done ? 'bg-green-900/30 border-green-600' : 'bg-ds-elevated border-ds-line/60'
            }`}
          >
            <h2 className="font-semibold mb-2">
              Lock 4: {LOCK_NAMES[4]} {lock4Done && '✓'}
            </h2>
            {lock4Done && art.plateBarcode ? (
              <div className="flex flex-col items-center gap-2">
                <p className="text-green-300 text-sm">Plate barcode generated.</p>
                <p className="font-mono text-lg">{art.plateBarcode}</p>
                {plateBarcodeSvg && (
                  <img src={plateBarcodeSvg} alt="Plate barcode" className="w-48 h-48" />
                )}
              </div>
            ) : (
              <p className="text-ds-ink-muted text-sm">Auto-generated after Lock 3.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
