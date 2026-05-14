'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, AlertTriangle, AlertCircle, Sparkles, Upload, FileText, Plus } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'
import { cn } from '@/lib/cn'
import { normalizeCartonSizeString } from '@/lib/carton-size'

type CartonCatalogItem = {
  id: string
  cartonName: string
  artworkCode: string | null
  gsm: number | null
  rate: number | null
  gstPct: number
  cartonSize: string | null
}

type ExtractedLineItem = {
  rawText: string
  quantity: number
  rate: number | null
  gstPct: number | null
  artworkCode: string | null
  matchedCartonId: string | null
  matchedCartonName: string | null
  matchConfidence: number
  newCartonProposal: {
    cartonName: string
    cartonSize: string | null
    gsm: number | null
    rate: number | null
    artworkCode: string | null
    reason: string
  } | null
}

type ExtractedPo = {
  poNumber: string
  poDate: string
  deliveryRequiredBy: string | null
  remarks: string | null
  lineItems: ExtractedLineItem[]
}

type CustomerDetection = {
  matchedCustomerId: string | null
  matchedCustomerName: string | null
  confidence: number
  evidence: string | null
  candidates: Array<{ id: string; name: string; reason: string }>
  reason: string | null
  newCustomerProposal: ProposedCustomer | null
}

type ProposedCustomer = {
  name: string
  gstNumber: string | null
  address: string | null
}

type ExtractResponse = {
  ok: true
  customerId: string
  customerName: string
  source: { filename: string; pageCount: number }
  extracted: ExtractedPo
  catalog: CartonCatalogItem[]
  customerDetection: CustomerDetection | null
  proposedNewCustomer: ProposedCustomer | null
}

/** Matches the extract / commit route sentinel — must stay in sync. */
const NEW_CUSTOMER_SENTINEL = '__new__'

type CustomerOption = { id: string; name: string }

/** Per-line UI state after the user has reviewed Claude's extraction. */
type ReviewLine = {
  key: string
  rawText: string
  quantity: number
  rate: number | null
  gstPct: number
  artworkCode: string | null
  /** 'existing' = link to a Carton by id; 'new' = create a new Carton on commit. */
  mode: 'existing' | 'new'
  /** When mode === 'existing'. */
  cartonId: string | null
  cartonName: string
  /** When mode === 'new'. Becomes a `newCartons[]` entry on commit. */
  newCartonClientKey: string | null
  newCartonName: string
  newCartonSize: string | null
  newCartonGsm: number | null
  newCartonRate: number | null
  newCartonArtwork: string | null
  /** Verbatim Claude confidence (0..1). */
  confidence: number
}

type DrawerProps = {
  isOpen: boolean
  onClose: () => void
  /** When provided, customer is pre-selected and locked. */
  presetCustomer?: CustomerOption | null
}

const CONFIDENCE_AUTO = 0.9

function confidenceTone(confidence: number, hasCarton: boolean): 'green' | 'yellow' | 'red' {
  if (!hasCarton) return 'red'
  if (confidence >= CONFIDENCE_AUTO) return 'green'
  if (confidence >= 0.7) return 'yellow'
  return 'red'
}

export function PoImportDrawer({ isOpen, onClose, presetCustomer }: DrawerProps) {
  const router = useRouter()
  const [step, setStep] = useState<'upload' | 'review'>('upload')

  // Customer search (only used when presetCustomer is null)
  const [customer, setCustomer] = useState<CustomerOption | null>(presetCustomer ?? null)
  const [custQuery, setCustQuery] = useState('')
  const [custOptions, setCustOptions] = useState<CustomerOption[]>([])
  const [custLoading, setCustLoading] = useState(false)

  // Upload
  const [file, setFile] = useState<File | null>(null)
  const [extracting, setExtracting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Review state
  const [extracted, setExtracted] = useState<ExtractedPo | null>(null)
  const [catalog, setCatalog] = useState<CartonCatalogItem[]>([])
  const [poNumber, setPoNumber] = useState('')
  const [poDate, setPoDate] = useState('')
  const [deliveryRequiredBy, setDeliveryRequiredBy] = useState('')
  const [remarks, setRemarks] = useState('')
  const [lines, setLines] = useState<ReviewLine[]>([])
  const [committing, setCommitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmAck, setConfirmAck] = useState(false)
  const [detection, setDetection] = useState<CustomerDetection | null>(null)
  /** Force the customer picker on the upload screen (after detect failure or "Change"). */
  const [showFallbackPicker, setShowFallbackPicker] = useState(false)
  /** Editable buyer details Claude read from the PDF when no roster match. Null
   *  means the operator either picked an existing customer or there was a hard
   *  detection failure with no proposal to confirm. */
  const [newCustomer, setNewCustomer] = useState<ProposedCustomer | null>(null)

  // Reset when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setStep('upload')
      setFile(null)
      setExtracted(null)
      setCatalog([])
      setLines([])
      setPoNumber('')
      setPoDate('')
      setDeliveryRequiredBy('')
      setRemarks('')
      setConfirmOpen(false)
      setConfirmAck(false)
      setDetection(null)
      setShowFallbackPicker(false)
      setNewCustomer(null)
      if (!presetCustomer) setCustomer(null)
    }
  }, [isOpen, presetCustomer])

  // Customer search
  useEffect(() => {
    if (presetCustomer) return
    if (!custQuery.trim()) {
      setCustOptions([])
      return
    }
    let active = true
    setCustLoading(true)
    fetch(`/api/customers?q=${encodeURIComponent(custQuery.trim())}`)
      .then((r) => r.json())
      .then((data: any) => {
        if (!active) return
        const rows: CustomerOption[] = Array.isArray(data)
          ? data.map((c: any) => ({ id: c.id, name: c.name }))
          : []
        setCustOptions(rows.slice(0, 8))
      })
      .catch(() => active && setCustOptions([]))
      .finally(() => active && setCustLoading(false))
    return () => {
      active = false
    }
  }, [custQuery, presetCustomer])

  const onPickFile = useCallback((picked: File | null) => {
    if (!picked) return
    if (picked.size > 8 * 1024 * 1024) {
      toast.error('PDF must be 8 MB or smaller')
      return
    }
    if (!picked.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Please upload a PDF file')
      return
    }
    setFile(picked)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault()
      onPickFile(e.dataTransfer.files?.[0] ?? null)
    },
    [onPickFile],
  )

  const runExtract = useCallback(async () => {
    if (!file) return
    // Customer is REQUIRED only when presetCustomer is locked; otherwise the
    // server auto-detects it from the PDF header in the same call.
    if (presetCustomer && !customer) return
    setExtracting(true)
    try {
      const form = new FormData()
      if (customer) form.append('customerId', customer.id)
      form.append('file', file)
      const res = await fetch('/api/purchase-orders/import/extract', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) {
        // Customer-detection failure — surface the picker so the operator can
        // pick manually and retry without re-uploading. Covers both "no match"
        // (422 with candidates) and "detect call threw" (502, no candidates).
        if (data?.customerDetection) {
          setDetection(data.customerDetection as CustomerDetection)
        }
        if (data?.needsCustomerSelection && !presetCustomer) {
          setShowFallbackPicker(true)
        }
        toast.error(data?.error ?? 'Extraction failed')
        return
      }
      const payload = data as ExtractResponse
      setCustomer({ id: payload.customerId, name: payload.customerName })
      setDetection(payload.customerDetection)
      // When extract returns a NEW_CUSTOMER_SENTINEL id, the buyer details
      // come back in proposedNewCustomer for the operator to confirm/edit.
      setNewCustomer(
        payload.customerId === NEW_CUSTOMER_SENTINEL && payload.proposedNewCustomer
          ? payload.proposedNewCustomer
          : null,
      )
      setExtracted(payload.extracted)
      setCatalog(payload.catalog)
      setPoNumber(payload.extracted.poNumber ?? '')
      setPoDate(payload.extracted.poDate ?? '')
      setDeliveryRequiredBy(payload.extracted.deliveryRequiredBy ?? '')
      setRemarks(payload.extracted.remarks ?? '')

      // Seed review lines from Claude's output.
      let newCartonCounter = 0
      const seeded: ReviewLine[] = payload.extracted.lineItems.map((li, idx) => {
        const hasMatch = !!li.matchedCartonId
        const confident = li.matchConfidence >= CONFIDENCE_AUTO
        if (hasMatch && confident) {
          return {
            key: `line-${idx}`,
            rawText: li.rawText,
            quantity: li.quantity,
            rate: li.rate,
            gstPct: li.gstPct ?? 12,
            artworkCode: li.artworkCode,
            mode: 'existing',
            cartonId: li.matchedCartonId!,
            cartonName: li.matchedCartonName ?? '',
            newCartonClientKey: null,
            newCartonName: '',
            newCartonSize: null,
            newCartonGsm: null,
            newCartonRate: null,
            newCartonArtwork: null,
            confidence: li.matchConfidence,
          }
        }
        // Yellow/red: default to "new carton" suggestion if Claude offered one,
        // otherwise leave as existing-but-unselected so user picks one.
        if (li.newCartonProposal) {
          newCartonCounter += 1
          return {
            key: `line-${idx}`,
            rawText: li.rawText,
            quantity: li.quantity,
            rate: li.rate,
            gstPct: li.gstPct ?? 12,
            artworkCode: li.artworkCode,
            mode: 'new',
            cartonId: null,
            cartonName: '',
            newCartonClientKey: `new-${newCartonCounter}`,
            newCartonName: li.newCartonProposal.cartonName,
            newCartonSize: normalizeCartonSizeString(li.newCartonProposal.cartonSize),
            newCartonGsm: li.newCartonProposal.gsm,
            newCartonRate: li.newCartonProposal.rate,
            newCartonArtwork: li.newCartonProposal.artworkCode,
            confidence: li.matchConfidence,
          }
        }
        return {
          key: `line-${idx}`,
          rawText: li.rawText,
          quantity: li.quantity,
          rate: li.rate,
          gstPct: li.gstPct ?? 12,
          artworkCode: li.artworkCode,
          mode: 'existing',
          cartonId: li.matchedCartonId,
          cartonName: li.matchedCartonName ?? '',
          newCartonClientKey: null,
          newCartonName: '',
          newCartonSize: null,
          newCartonGsm: null,
          newCartonRate: null,
          newCartonArtwork: null,
          confidence: li.matchConfidence,
        }
      })
      setLines(seeded)
      setStep('review')
    } catch (err) {
      console.error(err)
      toast.error('Network error during extraction')
    } finally {
      setExtracting(false)
    }
  }, [customer, file, presetCustomer])

  const updateLine = useCallback((key: string, patch: Partial<ReviewLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }, [])

  const newMasterLines = useMemo(() => lines.filter((l) => l.mode === 'new'), [lines])

  /** Per-line list of missing required fields on a new-master proposal. */
  const newMasterIssues = useMemo(() => {
    return newMasterLines.map((l) => {
      const missing: string[] = []
      if (!l.newCartonName.trim()) missing.push('name')
      if (!normalizeCartonSizeString(l.newCartonSize)) missing.push('size')
      if (l.newCartonRate == null) missing.push('rate')
      return { line: l, missing }
    })
  }, [newMasterLines])

  const hasBlockingNewMasterIssue = useMemo(
    () => newMasterIssues.some((x) => x.missing.length > 0),
    [newMasterIssues],
  )

  const scrollLineIntoView = useCallback((key: string) => {
    requestAnimationFrame(() => {
      const node = document.querySelector(`[data-line-key="${key}"]`) as HTMLElement | null
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const input = node?.querySelector('input') as HTMLInputElement | null
      input?.focus()
    })
  }, [])

  const validate = useCallback((): string | null => {
    if (!poDate) return 'PO date is required'
    if (
      customer?.id === NEW_CUSTOMER_SENTINEL &&
      !newCustomer?.name?.trim()
    ) {
      return 'Customer name is required for the new buyer being created.'
    }
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx]
      if (l.quantity <= 0) return `Line ${idx + 1}: quantity must be > 0`
      if (l.mode === 'existing' && !l.cartonId) {
        return `Line ${idx + 1}: pick a Carton or switch to "new"`
      }
    }
    return null
  }, [poDate, lines, customer, newCustomer])

  const doCommit = useCallback(async () => {
    if (!customer) return
    setCommitting(true)
    try {
      const newCartons = lines
        .filter((l) => l.mode === 'new' && l.newCartonClientKey)
        .map((l) => ({
          clientKey: l.newCartonClientKey!,
          cartonName: l.newCartonName.trim(),
          cartonSize: normalizeCartonSizeString(l.newCartonSize),
          gsm: l.newCartonGsm,
          rate: l.newCartonRate,
          gstPct: l.gstPct,
          artworkCode: l.newCartonArtwork || null,
        }))

      const payload = {
        customerId: customer.id,
        // Only forwarded when customerId is the new-customer sentinel; the
        // server creates the Customer row in the same transaction.
        newCustomer:
          customer.id === NEW_CUSTOMER_SENTINEL && newCustomer?.name?.trim()
            ? {
                name: newCustomer.name.trim(),
                gstNumber: newCustomer.gstNumber?.trim() || null,
                address: newCustomer.address?.trim() || null,
              }
            : null,
        poNumber: poNumber.trim() || null,
        poDate,
        deliveryRequiredBy: deliveryRequiredBy || null,
        remarks: remarks || null,
        newCartons,
        lineItems: lines.map((l) => ({
          cartonId: l.mode === 'existing' ? l.cartonId : null,
          newCartonClientKey: l.mode === 'new' ? l.newCartonClientKey : null,
          cartonName: l.mode === 'existing' ? l.cartonName : l.newCartonName.trim(),
          cartonSize:
            l.mode === 'existing' ? null : normalizeCartonSizeString(l.newCartonSize),
          quantity: l.quantity,
          artworkCode: l.artworkCode,
          rate: l.rate,
          gsm: l.mode === 'new' ? l.newCartonGsm : null,
          gstPct: l.gstPct,
        })),
      }

      const res = await fetch('/api/purchase-orders/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not save draft PO')
        return
      }
      toast.success(`Draft PO created — ${data.poNumber}`)
      setConfirmOpen(false)
      onClose()
      router.push(`/orders/purchase-orders/${data.id}`)
      router.refresh()
    } catch (err) {
      console.error(err)
      toast.error('Network error during commit')
    } finally {
      setCommitting(false)
    }
  }, [customer, newCustomer, poNumber, poDate, deliveryRequiredBy, remarks, lines, onClose, router])

  const prepareCommit = useCallback(() => {
    if (!customer) return
    const err = validate()
    if (err) {
      toast.error(err)
      return
    }
    if (newMasterLines.length > 0) {
      setConfirmAck(false)
      setConfirmOpen(true)
      return
    }
    void doCommit()
  }, [customer, validate, newMasterLines.length, doCommit])

  const headerMeta = useMemo(() => {
    if (step !== 'review' || !extracted) return null
    const greens = lines.filter((l) => l.mode === 'existing' && l.cartonId && l.confidence >= CONFIDENCE_AUTO).length
    const news = lines.filter((l) => l.mode === 'new').length
    const ambiguous = lines.length - greens - news
    const newCustomerBadge = customer?.id === NEW_CUSTOMER_SENTINEL
    return (
      <span className="text-xs text-[var(--text-muted)] flex items-center gap-2">
        {newCustomerBadge && <Badge tone="neutral">new customer</Badge>}
        <Badge tone="success">{greens} matched</Badge>
        {ambiguous > 0 && <Badge tone="warning">{ambiguous} to confirm</Badge>}
        {news > 0 && <Badge tone="neutral">{news} new master</Badge>}
      </span>
    )
  }, [step, extracted, lines, customer])

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-violet-500" />
          Import PO from PDF
        </span>
      }
      headerMeta={headerMeta}
      widthClass="w-[min(100%,clamp(640px,68vw,1100px))]"
      footer={
        step === 'review' ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-muted)]">
              Extracted by AI — please verify each line before saving.
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep('upload')} disabled={committing}>
                Back
              </Button>
              <Button onClick={prepareCommit} disabled={committing}>
                {committing ? 'Saving…' : 'Save as draft PO'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              onClick={runExtract}
              disabled={!file || extracting || (!!presetCustomer && !customer)}
            >
              {extracting ? 'Extracting…' : 'Extract with Claude'}
            </Button>
          </div>
        )
      }
    >
      {step === 'upload' && (
        <div className="space-y-4">
          {presetCustomer && customer && (
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Customer</label>
              <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
                <span className="text-sm">{customer.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Locked</span>
              </div>
            </div>
          )}

          {!presetCustomer && showFallbackPicker && (
            <div
              className={cn(
                'rounded-md border p-3 space-y-2',
                detection && !detection.matchedCustomerId
                  ? 'border-amber-500/50 bg-amber-500/[0.06]'
                  : 'border-[var(--border)] bg-[var(--bg-card)]',
              )}
            >
              <div className="text-xs text-[var(--text-muted)]">
                {detection && !detection.matchedCustomerId ? (
                  <>
                    <strong className="text-amber-700 dark:text-amber-300">
                      Couldn&apos;t identify the customer from this PDF.
                    </strong>
                    {detection.reason ? ` ${detection.reason}` : ''} Pick the right customer to continue.
                  </>
                ) : (
                  <>Pick the customer below, then click Extract again.</>
                )}
              </div>
              <CustomerPicker
                customer={customer}
                onChange={setCustomer}
                query={custQuery}
                onQueryChange={setCustQuery}
                options={custOptions}
                loading={custLoading}
              />
              {detection && detection.candidates.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  <span className="text-[11px] text-[var(--text-muted)] self-center">Top guesses:</span>
                  {detection.candidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCustomer({ id: c.id, name: c.name })}
                      className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--hover-row)]"
                      title={c.reason}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Customer's PO (PDF)
            </label>
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed cursor-pointer px-6 py-10 text-center transition',
                file
                  ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                  : 'border-[var(--border)] hover:border-[var(--accent)]/60 hover:bg-[var(--hover-row)]',
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <>
                  <FileText className="size-7 text-[var(--accent)]" />
                  <div className="text-sm font-medium">{file.name}</div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {(file.size / 1024).toFixed(0)} KB · click to replace
                  </div>
                </>
              ) : (
                <>
                  <Upload className="size-7 text-[var(--text-muted)]" />
                  <div className="text-sm font-medium">Drop a PDF here, or click to browse</div>
                  <div className="text-xs text-[var(--text-muted)]">
                    Text-based PDFs only — scans aren't supported yet.
                  </div>
                </>
              )}
            </label>
          </div>

          <div className="rounded-md bg-[var(--hover-row)] px-3 py-2 text-xs text-[var(--text-muted)] leading-relaxed">
            <strong className="text-[var(--text-primary)]">What happens next:</strong> Claude reads the PDF,
            {presetCustomer ? ' ' : ' identifies the customer, '}
            matches each line to your existing Carton master, and proposes new master rows where there&apos;s no match. You&apos;ll review the result before saving as a draft PO.
          </div>
        </div>
      )}

      {step === 'review' && extracted && (
        <div className="space-y-4">
          {/* Customer — read-only on review. Click "Change" to re-extract with a different one. */}
          {customer && customer.id !== NEW_CUSTOMER_SENTINEL && (
            <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <label className="text-xs font-medium text-[var(--text-muted)]">Customer</label>
                <span className="truncate text-sm">{customer.name}</span>
                {!presetCustomer && detection && detection.matchedCustomerId === customer.id && (
                  <span
                    title={
                      detection.evidence
                        ? `Detected from PDF: "${detection.evidence}"`
                        : 'Detected by Claude from the PDF header'
                    }
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                      detection.confidence >= 0.9
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                    )}
                  >
                    AI detected · {(detection.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </div>
              {!presetCustomer && (
                <button
                  type="button"
                  onClick={() => {
                    // Go back to upload so the user can pre-pick the right customer
                    // and re-run extraction (which re-loads the catalog for them).
                    setCustomer(null)
                    setDetection(null)
                    setExtracted(null)
                    setLines([])
                    setCatalog([])
                    setNewCustomer(null)
                    setShowFallbackPicker(true)
                    setStep('upload')
                  }}
                  className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Change
                </button>
              )}
            </div>
          )}

          {/* New-customer card — Claude read these from the PO header because no
              roster row matched. Operator can edit before they're created on save. */}
          {customer && customer.id === NEW_CUSTOMER_SENTINEL && newCustomer && (
            <div className="rounded-md border border-violet-500/40 bg-violet-500/[0.06] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-violet-500" />
                  <span className="text-xs font-medium text-violet-700 dark:text-violet-300 uppercase tracking-wide">
                    New customer · from PO header
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCustomer(null)
                    setDetection(null)
                    setExtracted(null)
                    setLines([])
                    setCatalog([])
                    setNewCustomer(null)
                    setShowFallbackPicker(true)
                    setStep('upload')
                  }}
                  className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Pick existing instead
                </button>
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                This customer isn&apos;t in your master yet. We&apos;ll create it when you save the draft PO. Please verify the fields.
              </div>
              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">
                    Customer name <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={newCustomer.name}
                    onChange={(e) => {
                      const name = e.target.value
                      setNewCustomer((c) => (c ? { ...c, name } : c))
                      setCustomer((cur) =>
                        cur ? { ...cur, name: name || cur.name } : cur,
                      )
                    }}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">
                      GST number
                    </label>
                    <input
                      value={newCustomer.gstNumber ?? ''}
                      onChange={(e) =>
                        setNewCustomer((c) => (c ? { ...c, gstNumber: e.target.value || null } : c))
                      }
                      placeholder="15-char GSTIN"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">
                      Address
                    </label>
                    <input
                      value={newCustomer.address ?? ''}
                      onChange={(e) =>
                        setNewCustomer((c) => (c ? { ...c, address: e.target.value || null } : c))
                      }
                      placeholder="Billing address"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Header fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">PO Number</label>
              <input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="Auto-generate"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                PO Date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Delivery Required By</label>
              <input
                type="date"
                value={deliveryRequiredBy}
                onChange={(e) => setDeliveryRequiredBy(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Remarks</label>
              <input
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Lines */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              Line Items ({lines.length})
            </div>
            {lines.map((line, idx) => (
              <LineRow
                key={line.key}
                idx={idx}
                line={line}
                catalog={catalog}
                onChange={(patch) => updateLine(line.key, patch)}
              />
            ))}
          </div>
        </div>
      )}

      {confirmOpen && (
        <NewMasterConfirmDialog
          rows={newMasterIssues}
          ack={confirmAck}
          onAckChange={setConfirmAck}
          blocked={hasBlockingNewMasterIssue}
          submitting={committing}
          onCancel={() => setConfirmOpen(false)}
          onEdit={(key) => {
            setConfirmOpen(false)
            scrollLineIntoView(key)
          }}
          onConfirm={() => {
            void doCommit()
          }}
        />
      )}
    </SlideOverPanel>
  )
}

function LineRow({
  idx,
  line,
  catalog,
  onChange,
}: {
  idx: number
  line: ReviewLine
  catalog: CartonCatalogItem[]
  onChange: (patch: Partial<ReviewLine>) => void
}) {
  const tone = confidenceTone(line.confidence, !!(line.mode === 'existing' && line.cartonId) || line.mode === 'new')
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return catalog.slice(0, 50)
    return catalog
      .filter((c) =>
        c.cartonName.toLowerCase().includes(q) ||
        (c.artworkCode && c.artworkCode.toLowerCase().includes(q)),
      )
      .slice(0, 50)
  }, [catalog, search])

  const toneClasses =
    tone === 'green'
      ? 'border-emerald-500/40 bg-emerald-500/[0.04]'
      : tone === 'yellow'
        ? 'border-amber-500/50 bg-amber-500/[0.06]'
        : 'border-rose-500/50 bg-rose-500/[0.05]'

  const ToneIcon = tone === 'green' ? CheckCircle2 : tone === 'yellow' ? AlertTriangle : AlertCircle
  const toneText = tone === 'green' ? 'text-emerald-600' : tone === 'yellow' ? 'text-amber-600' : 'text-rose-600'

  return (
    <div data-line-key={line.key} className={cn('rounded-lg border p-3', toneClasses)}>
      <div className="flex items-start gap-2 mb-2">
        <ToneIcon className={cn('size-4 mt-0.5', toneText)} />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-[var(--text-muted)]">Line {idx + 1} · confidence {(line.confidence * 100).toFixed(0)}%</div>
          <div className="text-xs text-[var(--text-muted)] truncate" title={line.rawText}>
            PDF: <span className="text-[var(--text-primary)]">{line.rawText}</span>
          </div>
        </div>
      </div>

      <div className="flex gap-1 mb-2">
        <button
          type="button"
          onClick={() => onChange({ mode: 'existing' })}
          className={cn(
            'text-xs px-2 py-1 rounded',
            line.mode === 'existing' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] border border-[var(--border)]',
          )}
        >
          Link to existing Carton
        </button>
        <button
          type="button"
          onClick={() => {
            if (!line.newCartonClientKey) {
              onChange({
                mode: 'new',
                newCartonClientKey: `new-${idx}-${Date.now()}`,
                newCartonName: line.newCartonName || line.cartonName || '',
              })
            } else {
              onChange({ mode: 'new' })
            }
          }}
          className={cn(
            'text-xs px-2 py-1 rounded',
            line.mode === 'new' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] border border-[var(--border)]',
          )}
        >
          Create new Carton master
        </button>
      </div>

      {line.mode === 'existing' ? (
        <div className="relative mb-2">
          <button
            type="button"
            onClick={() => setSearchOpen((s) => !s)}
            className="w-full text-left rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm flex items-center justify-between"
          >
            <span className={line.cartonId ? '' : 'text-[var(--text-muted)]'}>
              {line.cartonName || 'Select a Carton…'}
            </span>
            <span className="text-xs text-[var(--text-muted)]">{searchOpen ? '▴' : '▾'}</span>
          </button>
          {searchOpen && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-lg">
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or artwork code…"
                className="w-full border-b border-[var(--border)] bg-transparent px-3 py-2 text-sm focus:outline-none"
              />
              <div className="max-h-56 overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-[var(--text-muted)]">No matches.</div>
                ) : (
                  filtered.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onChange({
                          cartonId: c.id,
                          cartonName: c.cartonName,
                          gstPct: c.gstPct,
                          rate: line.rate ?? c.rate,
                        })
                        setSearchOpen(false)
                        setSearch('')
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--hover-row)]"
                    >
                      <div className="font-medium">{c.cartonName}</div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {c.artworkCode ? `AW ${c.artworkCode} · ` : ''}
                        {c.gsm ? `${c.gsm} GSM · ` : ''}
                        {c.rate ? `₹${c.rate}` : ''}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 mb-2">
          <input
            value={line.newCartonName}
            onChange={(e) => onChange({ newCartonName: e.target.value })}
            placeholder="New Carton name"
            className="col-span-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
          />
          <input
            value={line.newCartonSize ?? ''}
            onChange={(e) => onChange({ newCartonSize: e.target.value || null })}
            onBlur={(e) =>
              onChange({ newCartonSize: normalizeCartonSizeString(e.target.value) })
            }
            placeholder="Size (e.g. 120 x 210 mm)"
            className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
          />
          <input
            type="number"
            value={line.newCartonGsm ?? ''}
            onChange={(e) => onChange({ newCartonGsm: e.target.value ? Number(e.target.value) : null })}
            placeholder="GSM"
            className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
          />
          <input
            value={line.newCartonArtwork ?? ''}
            onChange={(e) => onChange({ newCartonArtwork: e.target.value || null })}
            placeholder="Artwork code"
            className="col-span-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
          />
          <input
            type="number"
            value={line.newCartonRate ?? ''}
            onChange={(e) => onChange({ newCartonRate: e.target.value ? Number(e.target.value) : null })}
            placeholder="Rate"
            className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
          />
        </div>
      )}

      <div className="grid grid-cols-4 gap-2">
        <NumberField
          label="Qty"
          value={line.quantity}
          onChange={(v) => onChange({ quantity: v ?? 0 })}
        />
        <NumberField
          label="Rate"
          value={line.rate ?? undefined}
          onChange={(v) => onChange({ rate: v ?? null })}
          step="0.01"
        />
        <NumberField
          label="GST %"
          value={line.gstPct}
          onChange={(v) => onChange({ gstPct: v ?? 12 })}
        />
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">Artwork</label>
          <input
            value={line.artworkCode ?? ''}
            onChange={(e) => onChange({ artworkCode: e.target.value || null })}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm"
          />
        </div>
      </div>
    </div>
  )
}

function CustomerPicker({
  customer,
  onChange,
  query,
  onQueryChange,
  options,
  loading,
}: {
  customer: CustomerOption | null
  onChange: (c: CustomerOption | null) => void
  query: string
  onQueryChange: (q: string) => void
  options: CustomerOption[]
  loading: boolean
}) {
  if (customer) {
    return (
      <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
        <span className="text-sm">{customer.name}</span>
        <button
          type="button"
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => onChange(null)}
        >
          Change
        </button>
      </div>
    )
  }
  return (
    <>
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Start typing customer name…"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm"
      />
      {(loading || options.length > 0) && (
        <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)] max-h-56 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Searching…</div>}
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onChange(c)
                onQueryChange('')
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--hover-row)]"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string
  value: number | undefined
  onChange: (v: number | null) => void
  step?: string
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">{label}</label>
      <input
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-sm tabular-nums"
      />
    </div>
  )
}

type ConfirmRow = { line: ReviewLine; missing: string[] }

function NewMasterConfirmDialog({
  rows,
  ack,
  onAckChange,
  blocked,
  submitting,
  onCancel,
  onEdit,
  onConfirm,
}: {
  rows: ConfirmRow[]
  ack: boolean
  onAckChange: (v: boolean) => void
  blocked: boolean
  submitting: boolean
  onCancel: () => void
  onEdit: (lineKey: string) => void
  onConfirm: () => void
}) {
  const count = rows.length
  const canConfirm = !blocked && ack && !submitting

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Plus className="size-4 text-violet-500" />
            <h3 className="text-sm font-semibold">
              Create {count} new Carton master{count === 1 ? '' : 's'}?
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-3">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            These items don&apos;t match anything in your catalog. Once saved, they&apos;ll appear in the
            Carton master and be used for future matching — please double-check.
          </p>

          {rows.map(({ line, missing }) => {
            const hasIssues = missing.length > 0
            return (
              <div
                key={line.key}
                className={cn(
                  'rounded-md border p-3 text-xs',
                  hasIssues
                    ? 'border-rose-500/60 bg-rose-500/[0.06]'
                    : 'border-[var(--border)] bg-[var(--bg-card)]',
                )}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {line.newCartonName.trim() || (
                        <span className="text-rose-600">[name missing]</span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate" title={line.rawText}>
                      from PDF: {line.rawText}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onEdit(line.key)}
                    disabled={submitting}
                    className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] hover:bg-[var(--hover-row)]"
                  >
                    Edit fields
                  </button>
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
                  <Field label="Size" value={line.newCartonSize} required missing={missing.includes('size')} />
                  <Field label="GSM" value={line.newCartonGsm} />
                  <Field
                    label="Rate"
                    value={line.newCartonRate == null ? null : `₹${line.newCartonRate}`}
                    required
                    missing={missing.includes('rate')}
                  />
                  <Field label="GST" value={`${line.gstPct}%`} />
                  <Field label="Artwork" value={line.newCartonArtwork} />
                  <Field label="Qty (this PO)" value={line.quantity} />
                </dl>

                {hasIssues && (
                  <div className="mt-2 text-[11px] text-rose-600">
                    Missing required: {missing.join(', ')}. Click &ldquo;Edit fields&rdquo; to fix.
                  </div>
                )}
              </div>
            )
          })}

          <label className="mt-2 flex items-start gap-2 rounded-md bg-[var(--hover-row)] px-3 py-2 text-xs">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => onAckChange(e.target.checked)}
              disabled={blocked || submitting}
              className="mt-0.5"
            />
            <span>
              I&apos;ve verified the fields above are correct. New cartons will be created in the master and
              used for future PO matching.
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Back to review
          </Button>
          <Button onClick={onConfirm} disabled={!canConfirm}>
            {submitting ? 'Saving…' : 'Confirm & save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  required,
  missing,
}: {
  label: string
  value: string | number | null | undefined
  required?: boolean
  missing?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </dt>
      <dd
        className={cn(
          'truncate text-xs',
          missing ? 'text-rose-600' : value == null || value === '' ? 'text-[var(--text-muted)]' : '',
        )}
      >
        {value == null || value === '' ? (missing ? 'missing' : '—') : String(value)}
      </dd>
    </div>
  )
}
