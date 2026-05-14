'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, AlertTriangle, AlertCircle, Sparkles, Upload, FileText } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'
import { cn } from '@/lib/cn'

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

type ExtractResponse = {
  ok: true
  customerId: string
  customerName: string
  source: { filename: string; pageCount: number }
  extracted: ExtractedPo
  catalog: CartonCatalogItem[]
}

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
    if (!customer || !file) return
    setExtracting(true)
    try {
      const form = new FormData()
      form.append('customerId', customer.id)
      form.append('file', file)
      const res = await fetch('/api/purchase-orders/import/extract', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error ?? 'Extraction failed')
        return
      }
      const payload = data as ExtractResponse
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
            newCartonSize: li.newCartonProposal.cartonSize,
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
  }, [customer, file])

  const updateLine = useCallback((key: string, patch: Partial<ReviewLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }, [])

  const commit = useCallback(async () => {
    if (!customer) return
    if (!poDate) {
      toast.error('PO date is required')
      return
    }
    const issues: string[] = []
    lines.forEach((l, idx) => {
      if (l.quantity <= 0) issues.push(`Line ${idx + 1}: quantity must be > 0`)
      if (l.mode === 'existing' && !l.cartonId) issues.push(`Line ${idx + 1}: pick a Carton or switch to "new"`)
      if (l.mode === 'new' && !l.newCartonName.trim()) issues.push(`Line ${idx + 1}: new Carton name required`)
    })
    if (issues.length) {
      toast.error(issues[0])
      return
    }

    setCommitting(true)
    try {
      const newCartons = lines
        .filter((l) => l.mode === 'new' && l.newCartonClientKey)
        .map((l) => ({
          clientKey: l.newCartonClientKey!,
          cartonName: l.newCartonName.trim(),
          cartonSize: l.newCartonSize || null,
          gsm: l.newCartonGsm,
          rate: l.newCartonRate,
          gstPct: l.gstPct,
          artworkCode: l.newCartonArtwork || null,
        }))

      const payload = {
        customerId: customer.id,
        poNumber: poNumber.trim() || null,
        poDate,
        deliveryRequiredBy: deliveryRequiredBy || null,
        remarks: remarks || null,
        newCartons,
        lineItems: lines.map((l) => ({
          cartonId: l.mode === 'existing' ? l.cartonId : null,
          newCartonClientKey: l.mode === 'new' ? l.newCartonClientKey : null,
          cartonName: l.mode === 'existing' ? l.cartonName : l.newCartonName.trim(),
          cartonSize: l.mode === 'existing' ? null : l.newCartonSize,
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
      onClose()
      router.push(`/orders/purchase-orders/${data.id}`)
      router.refresh()
    } catch (err) {
      console.error(err)
      toast.error('Network error during commit')
    } finally {
      setCommitting(false)
    }
  }, [customer, poNumber, poDate, deliveryRequiredBy, remarks, lines, onClose, router])

  const headerMeta = useMemo(() => {
    if (step !== 'review' || !extracted) return null
    const greens = lines.filter((l) => l.mode === 'existing' && l.cartonId && l.confidence >= CONFIDENCE_AUTO).length
    const news = lines.filter((l) => l.mode === 'new').length
    const ambiguous = lines.length - greens - news
    return (
      <span className="text-xs text-[var(--text-muted)] flex items-center gap-2">
        <Badge tone="success">{greens} matched</Badge>
        {ambiguous > 0 && <Badge tone="warning">{ambiguous} to confirm</Badge>}
        {news > 0 && <Badge tone="neutral">{news} new master</Badge>}
      </span>
    )
  }, [step, extracted, lines])

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
              <Button onClick={commit} disabled={committing}>
                {committing ? 'Saving…' : 'Save as draft PO'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={runExtract} disabled={!customer || !file || extracting}>
              {extracting ? 'Extracting…' : 'Extract with Claude'}
            </Button>
          </div>
        )
      }
    >
      {step === 'upload' && (
        <div className="space-y-4">
          {!presetCustomer && (
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Customer <span className="text-red-500">*</span>
              </label>
              {customer ? (
                <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
                  <span className="text-sm">{customer.name}</span>
                  <button
                    type="button"
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    onClick={() => setCustomer(null)}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={custQuery}
                    onChange={(e) => setCustQuery(e.target.value)}
                    placeholder="Start typing customer name…"
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm"
                  />
                  {(custLoading || custOptions.length > 0) && (
                    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)] max-h-56 overflow-y-auto">
                      {custLoading && (
                        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Searching…</div>
                      )}
                      {custOptions.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setCustomer(c)
                            setCustQuery('')
                            setCustOptions([])
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--hover-row)]"
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
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
            <strong className="text-[var(--text-primary)]">What happens next:</strong> Claude reads the PDF, matches each line to your existing Carton master, and proposes new master rows where there's no match. You'll review the result before saving as a draft PO.
          </div>
        </div>
      )}

      {step === 'review' && extracted && (
        <div className="space-y-4">
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
    <div className={cn('rounded-lg border p-3', toneClasses)}>
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
            placeholder="Size"
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
