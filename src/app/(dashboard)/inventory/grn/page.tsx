'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { toast } from '@/store/toastStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { GrnAllocationPrompt } from '@/components/inventory/GrnAllocationPrompt'
import { cn } from '@/lib/cn'

type InventoryItem = {
  id: string
  materialCode: string
  description: string
  unit: string
  boardType: string | null
  boardClassification?: string | null
  gsm: number | null
  sheetLength: number | null
  sheetWidth: number | null
  grainDirection: string | null
  caliperMicrons: number | null
  qtyAvailable: number
  qtyQuarantine: number
  qtyReserved?: number
  qtyFg?: number
  weightedAvgCost: number
  supplierId?: string | null
  supplierName?: string | null
  supplier?: { id: string; name: string } | null
  storageLocation?: string | null
  category?: string | null
  attributes?: string | null
  active?: boolean
}

type Supplier = {
  id: string
  name: string
}

type OpenPoRow = {
  id: string
  poNumber: string
  vendorName: string
  materialCode: string | null
  orderedKg: number
  receivedKg: number
  pendingKg: number
  requiredDeliveryDate: string | null
  status: string
  logisticsStatus: string | null
  daysOverdue: number | null
  linkedPrIds: string[]
  lineItems?: Array<{ materialCode: string | null; boardGrade: string; gsm: number; orderedKg: number }>
}

type VendorPoLine = {
  id: string
  boardGrade: string
  gsm: number
  grainDirection: string
  totalSheets: number
  totalWeightKg: number
  ratePerKg: number | null
  linkedMaterialRefs?: Array<{ materialId: string | null; materialCode: string | null }>
}

type VendorPoDetails = {
  id: string
  poNumber: string
  supplierId: string
  supplier: { name: string }
  orderDate: string
  status: string
  logisticsStatus?: string | null
  totalReceivedKg: number
  lines: VendorPoLine[]
}

type GrnShortageMatch = {
  shortageId: string
  jobCardId: string
  jobCardNumber: number | null
  planningId: string | null
  remainingQty: number
  shortageQty: number
  purchaseReqId: string | null
  linkedCartonId: string | null
  linkedCartonName: string | null
}

type GrnStatus = 'Draft' | 'Posted' | 'QC Hold' | 'Rejected'

type GrnRow = {
  id: string
  source: 'po' | 'manual'
  poLineId?: string
  materialId: string
  materialCode: string
  description: string
  poQty: number
  alreadyReceived: number
  pendingQty: number
  currentReceived: string
  acceptedQty: string
  rejectedQty: string
  uom: 'kg' | 'sheets'
  rate: string
  batchLot: string
  millDate: string
  mfgDate: string
  expiryDate: string
  palletId: string
  palletCount: string
  palletWeight: string
  remarks: string
  qcNote: string
  tolerancePct: number
}

const nf = new Intl.NumberFormat('en-IN')
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const today = () => new Date().toISOString().slice(0, 10)

function makeGrnNo() {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const seq = String((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) % 100000).padStart(5, '0')
  return `CI-GRN-${yy}${mm}${dd}-${seq}`
}

function lotFor(materialCode: string) {
  return `GRN-${today().replace(/-/g, '')}-${materialCode.replace(/[^A-Z0-9]/gi, '').slice(0, 8)}`
}

function num(value: string | number | null | undefined) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function rowAmount(row: GrnRow) {
  return num(row.acceptedQty) * num(row.rate)
}

function varianceTone(row: GrnRow) {
  const received = num(row.currentReceived)
  if (received <= 0) return 'neutral'
  const maxAllowed = row.pendingQty > 0 ? row.pendingQty * (1 + row.tolerancePct / 100) : Infinity
  if (received > maxAllowed) return 'over'
  if (row.pendingQty > 0 && received > row.pendingQty) return 'ok'
  if (received < row.pendingQty) return 'short'
  return 'ok'
}

function variancePct(row: GrnRow) {
  if (!(row.pendingQty > 0)) return 0
  return ((num(row.currentReceived) - row.pendingQty) / row.pendingQty) * 100
}

function rowStatusBadges(row: GrnRow) {
  const received = num(row.currentReceived)
  const accepted = num(row.acceptedQty)
  const rejected = num(row.rejectedQty)
  const badges: Array<{ label: string; tone: 'success' | 'warning' | 'error' | 'neutral' }> = []
  badges.push(row.source === 'po' ? { label: 'PO Matched', tone: row.materialId ? 'success' : 'error' } : { label: 'Non-PO', tone: 'neutral' })
  if (!row.materialId) badges.push({ label: 'Material Mismatch', tone: 'error' })
  const variance = varianceTone(row)
  if (variance === 'over') badges.push({ label: 'Tolerance Exceeded', tone: 'error' })
  else if (received > 0) badges.push({ label: 'Within Tolerance', tone: 'success' })
  if (row.batchLot) badges.push({ label: 'Batch Captured', tone: 'success' })
  if (rejected > 0) badges.push({ label: row.qcNote ? 'QC Required' : 'QC Pending', tone: 'warning' })
  else if (accepted > 0) badges.push({ label: 'QC Not Required', tone: 'neutral' })
  return badges.slice(0, 4)
}

function findInventoryForLine(line: VendorPoLine, items: InventoryItem[]) {
  const refs = line.linkedMaterialRefs ?? []
  const byId = refs.find((ref) => ref.materialId)
  if (byId?.materialId) {
    const match = items.find((item) => item.id === byId.materialId)
    if (match) return match
  }
  const byCode = refs.find((ref) => ref.materialCode)
  if (byCode?.materialCode) {
    const code = byCode.materialCode.toLowerCase()
    const match = items.find((item) => item.materialCode.toLowerCase() === code)
    if (match) return match
  }
  return items.find((item) => item.boardType === line.boardGrade && Number(item.gsm) === Number(line.gsm)) ?? null
}

function buildPoRows(po: VendorPoDetails, items: InventoryItem[]): GrnRow[] {
  const orderedKg = po.lines.reduce((sum, line) => sum + Number(line.totalWeightKg || 0), 0)
  return po.lines.map((line, index) => {
    const inv = findInventoryForLine(line, items)
    const poQty = Number(line.totalWeightKg || 0)
    const alreadyReceived = orderedKg > 0 ? Number(((Number(po.totalReceivedKg || 0) * poQty) / orderedKg).toFixed(3)) : 0
    const pendingQty = Math.max(0, Number((poQty - alreadyReceived).toFixed(3)))
    const materialCode = inv?.materialCode ?? line.linkedMaterialRefs?.find((ref) => ref.materialCode)?.materialCode ?? `${line.boardGrade}-${line.gsm}`
    return {
      id: `${po.id}:${line.id}:${index}`,
      source: 'po',
      poLineId: line.id,
      materialId: inv?.id ?? '',
      materialCode,
      description: inv?.description ?? `${line.boardGrade} board · ${line.gsm} GSM`,
      poQty,
      alreadyReceived,
      pendingQty,
      currentReceived: pendingQty > 0 ? String(Number(pendingQty.toFixed(3))) : '',
      acceptedQty: pendingQty > 0 ? String(Number(pendingQty.toFixed(3))) : '',
      rejectedQty: '0',
      uom: 'kg',
      rate: line.ratePerKg == null ? '' : String(Number(line.ratePerKg)),
      batchLot: lotFor(materialCode),
      millDate: '',
      mfgDate: '',
      expiryDate: '',
      palletId: '',
      palletCount: '',
      palletWeight: '',
      remarks: '',
      qcNote: '',
      tolerancePct: 3,
    }
  })
}

export default function GrnPage() {
  const [grnNo] = useState(makeGrnNo)
  const [grnDate, setGrnDate] = useState(today)
  const [supplier, setSupplier] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [poReference, setPoReference] = useState('')
  const [poId, setPoId] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [status, setStatus] = useState<GrnStatus>('Draft')
  const [rows, setRows] = useState<GrnRow[]>([])
  const [materials, setMaterials] = useState<InventoryItem[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [openPos, setOpenPos] = useState<OpenPoRow[]>([])
  const [poPickerOpen, setPoPickerOpen] = useState(false)
  const [materialDrawerRow, setMaterialDrawerRow] = useState<GrnRow | null>(null)
  const [quickEntryRowId, setQuickEntryRowId] = useState<string | null>(null)
  const [palletRowId, setPalletRowId] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [localSearch, setLocalSearch] = useState('')
  const [poFilter, setPoFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('open')
  const [supplierFilter, setSupplierFilter] = useState('All')
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [allocationPromptOpen, setAllocationPromptOpen] = useState(false)
  const [allocationGrnId, setAllocationGrnId] = useState('')
  const [allocationReceivedQty, setAllocationReceivedQty] = useState(0)
  const [allocationMaterialCode, setAllocationMaterialCode] = useState('')
  const [allocationMatches, setAllocationMatches] = useState<GrnShortageMatch[]>([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [inventoryRes, suppliersRes, posRes] = await Promise.all([
        fetch('/api/inventory', { cache: 'no-store' }),
        fetch('/api/procurement/suppliers', { cache: 'no-store' }),
        fetch('/api/inventory/paper-warehouse/open-pos', { cache: 'no-store' }),
      ])
      const [inventoryJson, suppliersJson, posJson] = await Promise.all([
        inventoryRes.json().catch(() => []),
        suppliersRes.json().catch(() => []),
        posRes.json().catch(() => []),
      ])
      if (cancelled) return
      if (!Array.isArray(inventoryJson)) {
        console.warn('[GRN material search] /api/inventory did not return an inventory array', inventoryJson)
      } else if (inventoryJson.length === 0) {
        console.warn('[GRN material search] Inventory preload returned zero materials')
      }
      setMaterials(Array.isArray(inventoryJson) ? inventoryJson : [])
      setSuppliers(Array.isArray(suppliersJson) ? suppliersJson : [])
      setOpenPos(Array.isArray(posJson) ? posJson : [])
    }
    void load().catch(() => toast.error('Could not load GRN reference data'))
    return () => {
      cancelled = true
    }
  }, [])

  const materialSearch = useAutoPopulate<InventoryItem>({
    storageKey: 'grn-material-invoice',
    search: async (query) => {
      const res = await fetch(`/api/inventory/material-search?q=${encodeURIComponent(query)}&limit=25`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.warn('[GRN material search] API request failed', { query, status: res.status, data })
        return []
      }
      const items = Array.isArray(data?.items) ? data.items as InventoryItem[] : []
      if (items.length === 0 && Number(data?.diagnostics?.totalActive ?? 0) > 0) {
        console.warn('[GRN material search] Active inventory exists, but no material matched the query', data.diagnostics)
      }
      return items
    },
    getId: (m) => m.id,
    getLabel: (m) => `${m.materialCode} - ${m.description}`,
    debounceMs: 250,
  })

  const supplierOptions = useMemo(() => {
    const q = supplier.trim().toLowerCase()
    if (!q) return []
    return suppliers
      .filter((s) => s.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const an = a.name.toLowerCase()
        const bn = b.name.toLowerCase()
        const aStarts = an.startsWith(q) ? 0 : 1
        const bStarts = bn.startsWith(q) ? 0 : 1
        return aStarts - bStarts || a.name.localeCompare(b.name)
      })
      .slice(0, 20)
  }, [supplier, suppliers])

  const filteredRows = useMemo(() => {
    const q = localSearch.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      [row.materialCode, row.description, row.batchLot, row.remarks].join(' ').toLowerCase().includes(q),
    )
  }, [rows, localSearch])

  const poPickerRows = useMemo(() => {
    const q = poFilter.trim().toLowerCase()
    return openPos.filter((po) => {
      if (supplierFilter !== 'All' && po.vendorName !== supplierFilter) return false
      if (statusFilter === 'pending' && po.pendingKg <= 0) return false
      if (statusFilter === 'overdue' && !(Number(po.daysOverdue ?? 0) > 0)) return false
      if (!q) return true
      return [po.poNumber, po.vendorName, po.materialCode ?? ''].join(' ').toLowerCase().includes(q)
    })
  }, [openPos, poFilter, statusFilter, supplierFilter])

  const summary = useMemo(() => rows.reduce(
    (acc, row) => {
      acc.poQty += row.poQty
      acc.pending += row.pendingQty
      acc.received += num(row.currentReceived)
      acc.accepted += num(row.acceptedQty)
      acc.rejected += num(row.rejectedQty)
      acc.amount += rowAmount(row)
      acc.pallets += Math.max(0, Math.floor(num(row.palletCount || (row.palletId ? 1 : 0))))
      if (num(row.rejectedQty) > 0 || row.qcNote.trim()) acc.qcPending += 1
      return acc
    },
    { poQty: 0, pending: 0, received: 0, accepted: 0, rejected: 0, amount: 0, pallets: 0, qcPending: 0 },
  ), [rows])

  const quickEntryRow = useMemo(
    () => rows.find((row) => row.id === quickEntryRowId) ?? null,
    [quickEntryRowId, rows],
  )
  const palletRow = useMemo(
    () => rows.find((row) => row.id === palletRowId) ?? null,
    [palletRowId, rows],
  )
  const drawerMaterial = useMemo(
    () => materialDrawerRow ? materials.find((item) => item.id === materialDrawerRow.materialId) ?? null : null,
    [materialDrawerRow, materials],
  )
  const drawerSupplier = drawerMaterial?.supplierId
    ? drawerMaterial.supplierName ?? drawerMaterial.supplier?.name ?? suppliers.find((item) => item.id === drawerMaterial.supplierId)?.name ?? '—'
    : supplier || '—'
  const selectedPoSummary = useMemo(() => {
    if (!poId) return null
    const totalLines = rows.length
    const receivedLines = rows.filter((row) => num(row.currentReceived) > 0).length
    const poValue = rows.reduce((sum, row) => sum + row.poQty * num(row.rate), 0)
    return {
      poNumber: poReference || 'Linked PO',
      supplier,
      totalLines,
      receivedLines,
      pendingLines: Math.max(0, totalLines - receivedLines),
      poValue,
      pendingValue: rows.reduce((sum, row) => sum + row.pendingQty * num(row.rate), 0),
      expectedDelivery: openPos.find((po) => po.id === poId)?.requiredDeliveryDate ?? null,
      tolerance: `${rows[0]?.tolerancePct ?? 3}%`,
    }
  }, [openPos, poId, poReference, rows, supplier])

  const receivingKpis = useMemo(() => [
    ['Lines Received', rows.filter((row) => num(row.currentReceived) > 0).length],
    ['Accepted Qty', nf.format(summary.accepted)],
    ['Rejected Qty', nf.format(summary.rejected)],
    ['GRN Value', money.format(summary.amount)],
  ], [rows, summary])

  const insightKpis = useMemo(() => [
    ['Today GRNs', rows.length ? 1 : 0],
    ['Pending PO Lines', openPos.filter((po) => po.pendingKg > 0).length],
    ['QC Items', summary.qcPending],
    ['Materials Received', rows.filter((row) => num(row.acceptedQty) > 0).length],
    ['Pallets Received', summary.pallets],
  ], [openPos, rows, summary])

  function updateRow(id: string, patch: Partial<GrnRow>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function materialPatch(material: InventoryItem): Partial<GrnRow> {
    return {
      materialId: material.id,
      materialCode: material.materialCode,
      description: material.description,
      uom: material.unit === 'kg' ? 'kg' : 'sheets',
      rate: material.weightedAvgCost ? String(Number(material.weightedAvgCost)) : '',
      batchLot: lotFor(material.materialCode),
    }
  }

  function addBlankRow() {
    const row: GrnRow = {
      id: `manual:blank:${Date.now()}`,
      source: 'manual',
      materialId: '',
      materialCode: '',
      description: '',
      poQty: 0,
      alreadyReceived: 0,
      pendingQty: 0,
      currentReceived: '',
      acceptedQty: '',
      rejectedQty: '0',
      uom: 'kg',
      rate: '',
      batchLot: '',
      millDate: '',
      mfgDate: '',
      expiryDate: '',
      palletId: '',
      palletCount: '',
      palletWeight: '',
      remarks: 'Non-PO GRN',
      qcNote: '',
      tolerancePct: 3,
    }
    setRows((prev) => [...prev, row])
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id))
  }

  function startNonPoReceipt() {
    setPoId('')
    setPoReference('')
    setStatus('Draft')
    if (rows.length === 0) addBlankRow()
  }

  function duplicateRow(row: GrnRow) {
    setRows((prev) => [
      ...prev,
      {
        ...row,
        id: `${row.source}:copy:${Date.now()}`,
        source: 'manual',
        poLineId: undefined,
        currentReceived: '',
        acceptedQty: '',
        rejectedQty: '0',
        batchLot: row.materialCode ? lotFor(row.materialCode) : '',
        palletId: '',
        palletCount: '',
        palletWeight: '',
        qcNote: '',
        remarks: row.remarks || 'Non-PO GRN',
      },
    ])
  }

  function tryLinkMaterial(row: GrnRow, value: string) {
    if (row.source !== 'manual') return
    const q = value.trim().toLowerCase()
    if (!q) return
    const material = materials.find((m) =>
      m.materialCode.toLowerCase() === q ||
      m.description.toLowerCase() === q ||
      `${m.materialCode} - ${m.description}`.toLowerCase() === q,
    )
    if (!material) return
    updateRow(row.id, materialPatch(material))
    if (!supplier && material.supplierId) {
      const s = suppliers.find((x) => x.id === material.supplierId)
      if (s) {
        setSupplier(s.name)
        setSupplierId(s.id)
      }
    }
  }

  function addManualRow(material: InventoryItem) {
    const row: GrnRow = {
      id: `manual:${material.id}:${Date.now()}`,
      source: 'manual',
      materialId: '',
      materialCode: '',
      description: '',
      poQty: 0,
      alreadyReceived: 0,
      pendingQty: 0,
      currentReceived: '',
      acceptedQty: '',
      rejectedQty: '0',
      uom: material.unit === 'kg' ? 'kg' : 'sheets',
      rate: material.weightedAvgCost ? String(Number(material.weightedAvgCost)) : '',
      batchLot: lotFor(material.materialCode),
      millDate: '',
      mfgDate: '',
      expiryDate: '',
      palletId: '',
      palletCount: '',
      palletWeight: '',
      remarks: 'Non-PO GRN',
      qcNote: '',
      tolerancePct: 3,
      ...materialPatch(material),
    }
    setRows((prev) => {
      const blankIndex = prev.findIndex(
        (item) =>
          item.source === 'manual' &&
          !item.materialId &&
          !item.materialCode.trim() &&
          !item.description.trim(),
      )
      if (blankIndex === -1) return [...prev, row]
      const next = [...prev]
      next[blankIndex] = {
        ...next[blankIndex],
        ...materialPatch(material),
        remarks: next[blankIndex].remarks || 'Non-PO GRN',
      }
      return next
    })
    setMaterials((prev) => prev.some((item) => item.id === material.id) ? prev : [material, ...prev])
    materialSearch.select(material)
    materialSearch.setQuery('')
    if (!supplier && material.supplierId) {
      const name = material.supplierName ?? material.supplier?.name ?? suppliers.find((x) => x.id === material.supplierId)?.name
      if (name) setSupplier(name)
      setSupplierId(material.supplierId)
    }
  }

  async function selectPo(po: OpenPoRow) {
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${po.id}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) throw new Error(data.error || 'Could not load PO')
      const details = data as VendorPoDetails
      setPoId(details.id)
      setPoReference(details.poNumber)
      setSupplier(details.supplier.name)
      setSupplierId(details.supplierId)
      setRows(buildPoRows(details, materials))
      setPoPickerOpen(false)
      setStatus('Draft')
      toast.success(`${details.poNumber} populated`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not select PO')
    }
  }

  function validatePost() {
    if (status === 'Posted') return 'Posted GRN is locked. Use reversal/amendment flow.'
    if (!rows.length) return 'Add at least one material row.'
    if (!invoiceNo.trim()) return 'Invoice/Bill No is required before posting.'
    if (!supplier.trim()) return 'Supplier is required.'
    for (const [index, row] of rows.entries()) {
      const received = num(row.currentReceived)
      const accepted = num(row.acceptedQty)
      const rejected = num(row.rejectedQty)
      const maxAllowed = row.pendingQty > 0 ? row.pendingQty * (1 + row.tolerancePct / 100) : Infinity
      if (!row.materialId) return `Row ${index + 1}: material master is not linked.`
      if (received <= 0) return `Row ${index + 1}: enter current received qty.`
      if (accepted < 0 || rejected < 0) return `Row ${index + 1}: accepted/rejected qty cannot be negative.`
      if (Math.abs(accepted + rejected - received) > 0.0001) return `Row ${index + 1}: accepted + rejected must equal current received.`
      if (row.pendingQty > 0 && received > maxAllowed) return `Row ${index + 1}: received qty exceeds pending qty beyond tolerance.`
      if (rejected > 0 && !row.qcNote.trim()) return `Row ${index + 1}: QC/rejection reason is required.`
    }
    return null
  }

  async function postGrn(event?: FormEvent) {
    event?.preventDefault()
    const validation = validatePost()
    if (validation) {
      toast.error(validation)
      return
    }
    setPosting(true)
    try {
      let firstAllocation: { id: string; materialCode: string; qty: number; matches: GrnShortageMatch[] } | null = null
      for (const row of rows) {
        const accepted = num(row.acceptedQty)
        if (accepted <= 0) continue
        const res = await fetch('/api/inventory/grn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            materialId: row.materialId,
            qty: accepted,
            entryUnit: row.uom,
            lotNumber: row.batchLot || undefined,
            millDate: row.millDate || row.mfgDate || null,
            palletCount: row.palletCount ? Math.max(0, Math.floor(num(row.palletCount))) : row.palletId ? 1 : null,
            costPerUnit: row.rate ? Number(row.rate) : undefined,
            pricePerKg: row.uom === 'kg' && row.rate ? Number(row.rate) : null,
            poReference: poReference || row.remarks || null,
            poQty: row.pendingQty || null,
            approvalOverride: false,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Could not post ${row.materialCode}`)
        const matches = Array.isArray(data.matchingShortages) ? (data.matchingShortages as GrnShortageMatch[]) : []
        if (!firstAllocation && matches.length > 0 && data.grnMovementId) {
          firstAllocation = { id: data.grnMovementId, materialCode: row.materialCode, qty: accepted, matches }
        }
      }
      setStatus(summary.rejected > 0 ? 'QC Hold' : 'Posted')
      toast.success('GRN posted. Accepted qty moved to quarantine; rejected qty kept out of usable stock.')
      if (firstAllocation) {
        setAllocationGrnId(firstAllocation.id)
        setAllocationMaterialCode(firstAllocation.materialCode)
        setAllocationReceivedQty(firstAllocation.qty)
        setAllocationMatches(firstAllocation.matches)
        setAllocationPromptOpen(true)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Posting failed')
    } finally {
      setPosting(false)
    }
  }

  function saveDraft() {
    if (!rows.length) {
      toast.error('Add a row before saving draft')
      return
    }
    setStatus('Draft')
    toast.success('Draft retained on this screen. Posting is the only action that updates stock.')
  }

  function sendToQc() {
    if (!rows.some((row) => num(row.rejectedQty) > 0)) {
      toast.error('Enter rejected qty on at least one row before sending to QC.')
      return
    }
    setStatus('QC Hold')
    toast.success('Marked as QC Hold. Rejected qty will not enter usable stock.')
  }

  const isPosted = status === 'Posted'

  return (
    <div className="min-h-screen bg-ds-main p-4 pb-24 text-ds-ink">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <PageHeader
          title="Goods Receipt (GRN)"
          subtitle="Invoice-style supplier receipt against PO or Non-PO material intake"
          action={
            <Link href="/inventory" className="text-sm text-ds-ink-muted hover:text-ds-ink">
              Back to Inventory
            </Link>
          }
        />

        <form onSubmit={postGrn} className="overflow-hidden rounded-2xl bg-ds-card shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <section className="px-5 py-4">
            <div className="grid gap-4 xl:grid-cols-[1fr_auto]">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">GRN No</div>
                  <div className="mt-1 font-mono text-sm font-bold text-ds-ink">{grnNo}</div>
                </div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                  Date
                  <input type="date" value={grnDate} onChange={(e) => setGrnDate(e.target.value)} disabled={isPosted} className="mt-1 h-9 w-full rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 text-sm text-ds-ink outline-none focus:border-ds-primary/50" />
                </label>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint md:col-span-2">
                  Supplier
                  <MasterSearchSelect
                    label="Supplier"
                    hideLabel
                    query={supplier}
                    onQueryChange={(value) => {
                      setSupplier(value)
                      const exact = suppliers.find((s) => s.name.toLowerCase() === value.trim().toLowerCase())
                      setSupplierId(exact?.id ?? '')
                    }}
                    onQueryCommit={(value) => {
                      const exact = suppliers.find((s) => s.name.toLowerCase() === value.trim().toLowerCase())
                      setSupplier(value.trim())
                      setSupplierId(exact?.id ?? '')
                    }}
                    loading={false}
                    options={supplierOptions}
                    lastUsed={[]}
                    browseOptions={[]}
                    onSelect={(s) => {
                      setSupplierId(s.id)
                      setSupplier(s.name)
                    }}
                    getOptionLabel={(s) => s.name}
                    emptyMessage="No supplier found."
                    placeholder="Search supplier..."
                    maxVisibleItems={20}
                    disabled={isPosted}
                    containerClassName="mt-1"
                    inputClassName="h-9 rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 py-1 text-sm text-ds-ink outline-none focus:border-ds-primary/50"
                    dropdownClassName="min-w-[320px] max-w-[520px]"
                  />
                </label>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                  PO No
                  <input value={poReference} onChange={(e) => setPoReference(e.target.value)} disabled={isPosted} className="mt-1 h-9 w-full rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 text-sm text-ds-ink outline-none focus:border-ds-primary/50" placeholder="Optional" />
                </label>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                  Invoice No
                  <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} disabled={isPosted} className="mt-1 h-9 w-full rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 text-sm text-ds-ink outline-none focus:border-ds-primary/50" />
                </label>
              </div>
              <div className="flex flex-wrap items-end justify-end gap-2">
                <span className={cn('rounded-full px-3 py-1.5 text-xs font-semibold', status === 'Posted' && 'bg-ds-success/15 text-ds-success', status === 'Draft' && 'bg-ds-warning/15 text-ds-warning', status === 'QC Hold' && 'bg-blue-500/15 text-blue-500', status === 'Rejected' && 'bg-ds-error/15 text-ds-error')}>{status}</span>
                <button type="submit" disabled={posting || isPosted} className="h-10 rounded-lg bg-ds-success px-4 text-sm font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50">{posting ? 'Posting...' : 'Post GRN'}</button>
                <button type="button" onClick={saveDraft} disabled={isPosted} className="h-10 rounded-lg bg-ds-main px-3 text-sm font-semibold text-ds-ink disabled:opacity-50">Save Draft</button>
                <button type="button" onClick={() => window.print()} className="h-10 rounded-lg bg-ds-main px-3 text-sm font-semibold text-ds-ink">Print</button>
                <div className="relative">
                  <button type="button" onClick={() => setMoreActionsOpen((open) => !open)} className="h-10 rounded-lg bg-ds-main px-3 text-sm font-semibold text-ds-ink">More</button>
                  {moreActionsOpen ? (
                    <div className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-ds-line/40 bg-ds-card p-2 shadow-2xl">
                      <button type="button" onClick={() => { sendToQc(); setMoreActionsOpen(false) }} disabled={isPosted} className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ds-ink hover:bg-ds-elevated disabled:opacity-50">Send QC</button>
                      <button type="button" onClick={() => { startNonPoReceipt(); setMoreActionsOpen(false) }} disabled={isPosted} className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ds-ink hover:bg-ds-elevated disabled:opacity-50">Receive Without PO</button>
                      <label className="mt-2 block px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                        Vehicle No
                        <input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} disabled={isPosted} className="mt-1 h-9 w-full rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 text-sm text-ds-ink" placeholder="Optional" />
                      </label>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="border-y border-ds-line/35 bg-ds-main/30 px-5 py-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {['Supplier / PO', 'Receive Materials', 'Review & Post'].map((step, index) => (
                <div key={step} className="flex items-center gap-2">
                  <span className={cn('grid h-7 w-7 place-items-center rounded-full text-xs font-bold', index === 0 && (supplier || poReference) ? 'bg-ds-success text-white' : index === 1 && rows.length ? 'bg-ds-success text-white' : index === 2 && summary.accepted > 0 ? 'bg-ds-success text-white' : 'bg-ds-card text-ds-ink-muted')}>{index + 1}</span>
                  <span className="font-semibold text-ds-ink-muted">{step}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="px-5 py-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {receivingKpis.map(([label, value]) => (
                <div key={String(label)} className="rounded-xl bg-ds-main/55 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
                  <div className="mt-1 text-xl font-bold tabular-nums text-ds-ink">{value}</div>
                </div>
              ))}
            </div>
            <details className="mt-2 text-xs text-ds-ink-muted">
              <summary className="cursor-pointer select-none font-semibold text-ds-ink-faint">More Insights</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {insightKpis.map(([label, value]) => (
                  <span key={String(label)} className="rounded-full bg-ds-main px-3 py-1">{label}: <b>{value}</b></span>
                ))}
              </div>
            </details>
          </section>

          {selectedPoSummary ? (
            <section className="border-b border-ds-line/50 px-4 py-2">
              <div className="grid gap-2 rounded border border-ds-line/40 bg-ds-main/40 px-3 py-2 text-xs md:grid-cols-4 xl:grid-cols-8">
                <div><span className="text-ds-ink-faint">PO</span><div className="font-mono font-bold text-ds-primary">{selectedPoSummary.poNumber}</div></div>
                <div><span className="text-ds-ink-faint">Supplier</span><div className="truncate font-semibold text-ds-ink">{selectedPoSummary.supplier || '—'}</div></div>
                <div><span className="text-ds-ink-faint">Lines</span><div className="font-semibold text-ds-ink">{selectedPoSummary.receivedLines}/{selectedPoSummary.totalLines} received</div></div>
                <div><span className="text-ds-ink-faint">Pending Lines</span><div className="font-semibold text-ds-ink">{selectedPoSummary.pendingLines}</div></div>
                <div><span className="text-ds-ink-faint">PO Value</span><div className="font-semibold text-ds-ink">{money.format(selectedPoSummary.poValue)}</div></div>
                <div><span className="text-ds-ink-faint">Pending Value</span><div className="font-semibold text-ds-ink">{money.format(selectedPoSummary.pendingValue)}</div></div>
                <div><span className="text-ds-ink-faint">Expected</span><div className="font-semibold text-ds-ink">{selectedPoSummary.expectedDelivery ? new Date(selectedPoSummary.expectedDelivery).toLocaleDateString('en-IN') : '—'}</div></div>
                <div><span className="text-ds-ink-faint">Tolerance</span><div className="font-semibold text-ds-success">±{selectedPoSummary.tolerance}</div></div>
              </div>
            </section>
          ) : null}

          <section className="border-t border-ds-line/30 px-5 py-4">
            <div className="grid gap-3 xl:grid-cols-[auto_1fr_auto]">
              <button
                type="button"
                onClick={addBlankRow}
                disabled={isPosted}
                className="h-11 rounded-lg bg-ds-primary px-4 text-sm font-bold text-white shadow-sm disabled:opacity-50"
              >
                + Add Material
              </button>
              <div className="min-w-[260px]">
                <MasterSearchSelect
                  label="Material search"
                  query={materialSearch.query}
                  onQueryChange={materialSearch.setQuery}
                  loading={materialSearch.loading}
                  options={materialSearch.options}
                  lastUsed={materialSearch.lastUsed}
                  onSelect={addManualRow}
                  getOptionLabel={(m) => `${m.materialCode} - ${m.description}`}
                  getOptionMeta={(m) => [
                    m.supplierName ?? m.supplier?.name,
                    m.boardClassification ?? m.boardType,
                    m.gsm ? `${m.gsm} GSM` : null,
                    m.sheetLength && m.sheetWidth ? `${m.sheetLength}x${m.sheetWidth}` : null,
                    m.storageLocation ? `Loc ${m.storageLocation}` : null,
                    m.category ? `Cat ${m.category}` : null,
                    `Stock ${nf.format(m.qtyAvailable ?? 0)}`,
                  ].filter(Boolean).join(' · ')}
                  placeholder="Search code, name, supplier item, board, GSM, size, warehouse code..."
                  recentLabel="Recent materials"
                  loadingMessage="Searching materials..."
                  emptyMessage="No matching materials found"
                  disabled={isPosted}
                  maxVisibleItems={20}
                  inputClassName="h-11 rounded-lg border border-ds-line/50 bg-ds-main/60 px-3 py-2 text-sm outline-none focus:border-ds-primary/50"
                />
              </div>
              <div className="flex flex-wrap gap-2 xl:justify-end">
                <button type="button" onClick={() => setPoPickerOpen(true)} disabled={isPosted} className="h-11 rounded-lg bg-ds-main px-3 text-sm font-semibold text-ds-ink disabled:opacity-50">Link PO</button>
                <select
                  value={supplierFilter}
                  onChange={(e) => setSupplierFilter(e.target.value)}
                  className="h-11 rounded-lg border border-ds-line/50 bg-ds-main/60 px-3 text-sm text-ds-ink"
                >
                  <option value="All">All suppliers</option>
                  {Array.from(new Set(openPos.map((po) => po.vendorName))).map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <input
                  value={poFilter}
                  onChange={(e) => setPoFilter(e.target.value)}
                  className="h-11 w-36 rounded-lg border border-ds-line/50 bg-ds-main/60 px-3 text-sm text-ds-ink"
                  placeholder="PO filter"
                />
              </div>
            </div>
          </section>

          <section className="overflow-x-auto px-5 pb-4">
            <table className="w-full min-w-[1040px] border-separate border-spacing-0 text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-ds-ink-faint">
                <tr>
                  {['Material', 'Expected', 'Received', 'Accepted', 'Rejected', 'Batch', 'Pallet', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-ds-line/40 px-3 py-3 text-left font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-16 text-center text-sm text-ds-ink-muted">
                      <div className="mx-auto max-w-md rounded-2xl bg-ds-main/55 p-8 shadow-sm">
                        <h3 className="text-lg font-bold text-ds-ink">Start receiving materials</h3>
                        <p className="mt-2 text-sm text-ds-ink-muted">Link a purchase order when available, or add a material manually for Non-PO receiving.</p>
                        <div className="mt-5 flex justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => setPoPickerOpen(true)}
                            disabled={isPosted}
                            className="rounded-lg bg-ds-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                          >
                            Link PO
                          </button>
                          <button
                            type="button"
                            onClick={addBlankRow}
                            disabled={isPosted}
                            className="rounded-lg bg-ds-card px-4 py-2 text-sm font-semibold text-ds-ink disabled:opacity-50"
                          >
                            Add Material Manually
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : filteredRows.map((row) => {
                  const rejected = num(row.rejectedQty) > 0
                  const expectedQty = row.pendingQty || row.poQty
                  const material = materials.find((item) => item.id === row.materialId)
                  return (
                    <tr key={row.id} onClick={() => setQuickEntryRowId(row.id)} className="cursor-pointer align-middle hover:bg-ds-main/40">
                      <td className="min-w-[320px] border-b border-ds-line/25 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        {row.source === 'manual' && !row.materialId ? (
                          <div className="grid gap-1.5">
                            <input value={row.materialCode} disabled={isPosted} onChange={(e) => updateRow(row.id, { materialCode: e.target.value, materialId: '' })} onBlur={(e) => tryLinkMaterial(row, e.target.value)} className="w-full rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 py-1.5 font-mono text-xs font-semibold text-ds-ink" placeholder="Material code" />
                            <input value={row.description} disabled={isPosted} onChange={(e) => updateRow(row.id, { description: e.target.value, materialId: '' })} onBlur={(e) => tryLinkMaterial(row, e.target.value)} className="w-full rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 py-1.5 text-sm text-ds-ink" placeholder="Description" />
                          </div>
                        ) : (
                          <button type="button" onClick={() => setMaterialDrawerRow(row)} className="block max-w-[360px] text-left">
                            <span className="block font-mono text-xs font-bold text-ds-primary">{row.materialCode || 'Unlinked material'}</span>
                            <span className="mt-0.5 block truncate text-base font-bold text-ds-ink">{row.description || 'Material description required'}</span>
                            <span className="mt-1 block text-xs text-ds-ink-muted">
                              {[material?.gsm ? `${material.gsm} GSM` : null, material?.boardClassification ?? material?.boardType, material?.category ? `Cat ${material.category}` : null].filter(Boolean).join(' / ') || (row.source === 'manual' ? 'Non-PO material' : 'PO material')}
                            </span>
                          </button>
                        )}
                      </td>
                      <td className="border-b border-ds-line/25 px-3 py-3 text-right tabular-nums text-ds-ink-muted">
                        <div className="font-semibold text-ds-ink">{expectedQty ? nf.format(expectedQty) : '-'}</div>
                        <div className="text-[11px]">{row.uom}</div>
                      </td>
                      {(['currentReceived', 'acceptedQty', 'rejectedQty'] as const).map((key) => (
                        <td key={key} className="border-b border-ds-line/25 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={row[key]}
                            disabled={isPosted}
                            onChange={(e) => {
                              const value = e.target.value
                              const received = key === 'currentReceived' ? num(value) : num(row.currentReceived)
                              const rejectedQty = key === 'rejectedQty' ? Math.min(num(value), received) : num(row.rejectedQty)
                              const acceptedQty = key === 'acceptedQty' ? Math.min(num(value), Math.max(0, received - rejectedQty)) : Math.max(0, received - rejectedQty)
                              if (key === 'currentReceived') updateRow(row.id, { currentReceived: value, acceptedQty: value, rejectedQty: '0' })
                              else if (key === 'rejectedQty') updateRow(row.id, { rejectedQty: String(rejectedQty), acceptedQty: String(acceptedQty), qcNote: rejectedQty > 0 && !row.qcNote ? 'QC review required' : row.qcNote })
                              else updateRow(row.id, { acceptedQty: String(acceptedQty) })
                            }}
                            className={cn('w-24 rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 py-2 text-right text-sm font-semibold tabular-nums text-ds-ink outline-none focus:border-ds-primary/50', key === 'rejectedQty' && rejected && 'border-ds-error/50 bg-ds-error/10 text-ds-error')}
                          />
                        </td>
                      ))}
                      <td className="border-b border-ds-line/25 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input value={row.batchLot} disabled={isPosted} onChange={(e) => updateRow(row.id, { batchLot: e.target.value })} className="w-36 rounded-lg border border-ds-line/50 bg-ds-main/60 px-2 py-2 text-sm text-ds-ink" />
                      </td>
                      <td className="border-b border-ds-line/25 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <button type="button" onClick={() => setPalletRowId(row.id)} className="rounded-full bg-ds-main px-3 py-1.5 text-xs font-semibold text-ds-ink-muted hover:text-ds-ink">
                          {row.palletCount || row.palletId ? `${row.palletCount || 1} pallet` : 'Add'}
                        </button>
                      </td>
                      <td className="border-b border-ds-line/25 px-3 py-3">
                        <div className="flex max-w-[220px] flex-wrap gap-1.5">
                          {(rowStatusBadges(row).filter((badge) => ['Non-PO', 'PO Matched', 'Batch Captured', 'QC Pending', 'QC Required', 'Within Tolerance'].includes(badge.label)).slice(0, 2)).map((badge) => (
                            <span key={badge.label} className={cn('rounded-full px-2 py-1 text-[11px] font-semibold', badge.tone === 'success' && 'bg-ds-success/10 text-ds-success', badge.tone === 'warning' && 'bg-ds-warning/10 text-ds-warning', badge.tone === 'error' && 'bg-ds-error/10 text-ds-error', badge.tone === 'neutral' && 'bg-ds-main text-ds-ink-muted')}>{badge.label === 'PO Matched' ? 'PO Linked' : badge.label}</span>
                          ))}
                          {num(row.currentReceived) > 0 && row.materialId ? <span className="rounded-full bg-ds-success/10 px-2 py-1 text-[11px] font-semibold text-ds-success">Ready to Post</span> : null}
                        </div>
                      </td>
                      <td className="border-b border-ds-line/25 px-3 py-3">
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <button type="button" onClick={() => setQuickEntryRowId(row.id)} className="rounded-lg bg-ds-primary/10 px-2.5 py-1.5 text-xs font-bold text-ds-primary">Receive</button>
                          <button type="button" onClick={() => setMaterialDrawerRow(row)} className="rounded-lg bg-ds-main px-2.5 py-1.5 text-xs font-semibold text-ds-ink-muted hover:text-ds-ink">Details</button>
                          <details className="relative">
                            <summary className="list-none rounded-lg bg-ds-main px-2.5 py-1.5 text-xs font-semibold text-ds-ink-muted hover:text-ds-ink">More</summary>
                            <div className="absolute right-0 z-20 mt-1 w-32 rounded-lg border border-ds-line/40 bg-ds-card p-1 shadow-xl">
                              <button type="button" disabled={isPosted} onClick={() => duplicateRow(row)} className="w-full rounded px-2 py-1.5 text-left text-xs font-semibold text-ds-ink-muted hover:bg-ds-elevated disabled:opacity-40">Duplicate</button>
                              <button type="button" disabled={isPosted} onClick={() => removeRow(row.id)} className="w-full rounded px-2 py-1.5 text-left text-xs font-semibold text-ds-error hover:bg-ds-error/10 disabled:opacity-40">Delete</button>
                            </div>
                          </details>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          <section className="sticky bottom-0 z-20 border-t border-ds-line/40 bg-ds-card/95 px-5 py-3 shadow-[0_-12px_28px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-6 text-sm">
                <div><span className="text-ds-ink-faint">Accepted Stock</span><div className="text-lg font-bold text-ds-success">+{nf.format(summary.accepted)}</div></div>
                <div><span className="text-ds-ink-faint">QC Hold</span><div className="text-lg font-bold text-ds-warning">+{nf.format(summary.rejected)}</div></div>
                <div><span className="text-ds-ink-faint">GRN Value</span><div className="text-lg font-bold text-ds-primary">{money.format(summary.amount)}</div></div>
              </div>
              <button type="submit" disabled={posting || isPosted} className="h-11 rounded-lg bg-ds-success px-5 text-sm font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50">{posting ? 'Posting...' : 'Post GRN'}</button>
            </div>
          </section>
        </form>
      </div>

      {poPickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="max-h-[84vh] w-full max-w-5xl overflow-hidden rounded-ds-md bg-ds-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-ds-line/50 p-4">
              <div>
                <h3 className="text-lg font-semibold text-ds-ink">Select Purchase Order</h3>
                <p className="text-xs text-ds-ink-muted">Supplier, PO number, PO date, pending qty and logistics status.</p>
              </div>
              <button type="button" onClick={() => setPoPickerOpen(false)} className="rounded bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink">Close</button>
            </div>
            <div className="max-h-[68vh] overflow-auto p-4">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wider text-ds-ink-faint">
                  <tr>
                    <th className="pb-2">Supplier</th>
                    <th className="pb-2">PO Number</th>
                    <th className="pb-2">PO Date</th>
                    <th className="pb-2 text-right">Pending Qty</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {poPickerRows.map((po) => (
                    <tr key={po.id} className="border-t border-ds-line/40">
                      <td className="py-2 pr-3 font-medium text-ds-ink">{po.vendorName}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-ds-primary">{po.poNumber}</td>
                      <td className="py-2 pr-3 text-ds-ink-muted">{po.requiredDeliveryDate ? new Date(po.requiredDeliveryDate).toLocaleDateString('en-IN') : '-'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{nf.format(po.pendingKg)} kg</td>
                      <td className="py-2 pr-3 capitalize text-ds-ink-muted">{po.logisticsStatus?.replace(/_/g, ' ') ?? po.status}</td>
                      <td className="py-2 text-right">
                        <button type="button" onClick={() => selectPo(po)} className="rounded bg-ds-primary px-3 py-1.5 text-xs font-semibold text-white">Select</button>
                      </td>
                    </tr>
                  ))}
                  {poPickerRows.length === 0 ? (
                    <tr><td colSpan={6} className="py-8 text-center text-ds-ink-muted">No matching open POs.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {quickEntryRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded bg-ds-card p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-ds-ink">Receive Material</h3>
                <p className="font-mono text-xs text-ds-primary">{quickEntryRow.materialCode || 'Unlinked material'}</p>
                <p className="text-sm text-ds-ink-muted">{quickEntryRow.description || 'Enter material details in the row.'}</p>
              </div>
              <button type="button" onClick={() => setQuickEntryRowId(null)} className="rounded bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink">Close</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-semibold text-ds-ink-muted">
                Received Qty
                <input type="number" min={0} step="any" value={quickEntryRow.currentReceived} disabled={isPosted} onChange={(e) => updateRow(quickEntryRow.id, { currentReceived: e.target.value, acceptedQty: e.target.value, rejectedQty: '0' })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Accepted Qty
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={quickEntryRow.acceptedQty}
                  disabled={isPosted}
                  onChange={(e) => {
                    const received = num(quickEntryRow.currentReceived)
                    const rejected = num(quickEntryRow.rejectedQty)
                    updateRow(quickEntryRow.id, { acceptedQty: String(Math.min(num(e.target.value), Math.max(0, received - rejected))) })
                  }}
                  className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink"
                />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Rejected Qty
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={quickEntryRow.rejectedQty}
                  disabled={isPosted}
                  onChange={(e) => {
                    const received = num(quickEntryRow.currentReceived)
                    const rejected = Math.min(num(e.target.value), received)
                    updateRow(quickEntryRow.id, {
                      rejectedQty: String(rejected),
                      acceptedQty: String(Math.max(0, received - rejected)),
                      qcNote: rejected > 0 && !quickEntryRow.qcNote ? 'QC review required' : quickEntryRow.qcNote,
                    })
                  }}
                  className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink"
                />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Batch / Lot No
                <input value={quickEntryRow.batchLot} disabled={isPosted} onChange={(e) => updateRow(quickEntryRow.id, { batchLot: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Pallet Number
                <input value={quickEntryRow.palletId} disabled={isPosted} onChange={(e) => updateRow(quickEntryRow.id, { palletId: e.target.value, palletCount: quickEntryRow.palletCount || '1' })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Manufacturing Date
                <input type="date" value={quickEntryRow.mfgDate || quickEntryRow.millDate} disabled={isPosted} onChange={(e) => updateRow(quickEntryRow.id, { mfgDate: e.target.value, millDate: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Expiry Date
                <input type="date" value={quickEntryRow.expiryDate} disabled={isPosted} onChange={(e) => updateRow(quickEntryRow.id, { expiryDate: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted sm:col-span-2">
                Remarks / QC Reason
                <input value={num(quickEntryRow.rejectedQty) > 0 ? quickEntryRow.qcNote : quickEntryRow.remarks} disabled={isPosted} onChange={(e) => updateRow(quickEntryRow.id, num(quickEntryRow.rejectedQty) > 0 ? { qcNote: e.target.value } : { remarks: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
            </div>
            <div className="mt-4 rounded bg-ds-elevated/45 p-3 text-xs">
              <div className="font-semibold uppercase tracking-wider text-ds-ink-faint">Tolerance</div>
              <div className="mt-1 flex flex-wrap gap-4 text-ds-ink-muted">
                <span>Ordered: <b className="text-ds-ink">{nf.format(quickEntryRow.poQty || quickEntryRow.pendingQty)}</b></span>
                <span>Received: <b className="text-ds-ink">{nf.format(num(quickEntryRow.currentReceived))}</b></span>
                <span>Tolerance: <b className="text-ds-ink">+{quickEntryRow.tolerancePct}%</b></span>
                <span>Status: <b className={varianceTone(quickEntryRow) === 'over' ? 'text-ds-error' : 'text-ds-success'}>{varianceTone(quickEntryRow) === 'over' ? 'Tolerance Exceeded' : 'Within Tolerance'}</b></span>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setQuickEntryRowId(null)} className="rounded bg-ds-primary px-4 py-2 text-sm font-semibold text-white">Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {materialDrawerRow ? (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto border-l border-ds-line/50 bg-ds-card p-4 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-ds-ink">{materialDrawerRow.materialCode}</h3>
              <p className="text-sm text-ds-ink-muted">{materialDrawerRow.description}</p>
            </div>
            <button type="button" onClick={() => setMaterialDrawerRow(null)} className="rounded bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink">Close</button>
          </div>
          <div className="mt-4 space-y-3 text-sm">
            <div className="rounded bg-ds-elevated p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Material Intelligence</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <span>Board Grade: <b>{drawerMaterial?.boardClassification ?? '—'}</b></span>
                <span>Board Type: <b>{drawerMaterial?.boardType ?? '—'}</b></span>
                <span>GSM: <b>{drawerMaterial?.gsm ?? '—'}</b></span>
                <span>Size: <b>{drawerMaterial?.sheetLength && drawerMaterial.sheetWidth ? `${drawerMaterial.sheetLength} x ${drawerMaterial.sheetWidth}` : '—'}</b></span>
                <span>Supplier: <b>{drawerSupplier}</b></span>
                <span>Location: <b>{drawerMaterial?.storageLocation ?? 'Warehouse'}</b></span>
                <span>Current Stock: <b>{nf.format(drawerMaterial?.qtyAvailable ?? 0)}</b></span>
                <span>Reserved Stock: <b>{nf.format(drawerMaterial?.qtyReserved ?? 0)}</b></span>
                <span>Last Purchase Rate: <b>{money.format(drawerMaterial?.weightedAvgCost ?? num(materialDrawerRow.rate))}</b></span>
                <span>Last GRN Date: <b>{materialDrawerRow.millDate || '—'}</b></span>
              </div>
            </div>
            <div className="rounded bg-ds-elevated p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">PO / Receipt</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <span>PO Qty: <b>{nf.format(materialDrawerRow.poQty)}</b></span>
                <span>Pending: <b>{nf.format(materialDrawerRow.pendingQty)}</b></span>
                <span>Accepted: <b>{nf.format(num(materialDrawerRow.acceptedQty))}</b></span>
                <span>Rejected: <b>{nf.format(num(materialDrawerRow.rejectedQty))}</b></span>
              </div>
            </div>
            <div className="rounded bg-ds-elevated p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Recent Receipt History</div>
              <div className="mt-2 space-y-1 text-xs text-ds-ink-muted">
                <div>{grnNo} · {nf.format(num(materialDrawerRow.acceptedQty))} {materialDrawerRow.uom} · {money.format(rowAmount(materialDrawerRow))}</div>
                <div>Pending POs: {poPickerRows.filter((po) => po.materialCode === materialDrawerRow.materialCode || po.vendorName === supplier).length}</div>
              </div>
            </div>
            <div className="rounded bg-ds-elevated p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Audit Trail</div>
              <div className="mt-2 grid gap-1 text-xs text-ds-ink-muted">
                <span>Created By: Current operator</span>
                <span>Modified By: Current operator</span>
                <span>Posted By: {status === 'Posted' ? 'Current operator' : '—'}</span>
                <span>Posting Date: {status === 'Posted' ? new Date().toLocaleString('en-IN') : '—'}</span>
                <span>QC Approved By: {num(materialDrawerRow.rejectedQty) > 0 ? 'QC pending' : 'Not required'}</span>
              </div>
            </div>
            <label className="block text-xs font-semibold text-ds-ink-muted">
              QC Note
              <textarea value={materialDrawerRow.qcNote} onChange={(e) => {
                updateRow(materialDrawerRow.id, { qcNote: e.target.value })
                setMaterialDrawerRow((prev) => prev ? { ...prev, qcNote: e.target.value } : prev)
              }} rows={4} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
            </label>
          </div>
        </div>
      ) : null}

      {palletRowId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-ds-md bg-ds-card p-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-ds-ink">Pallet Management</h3>
            <p className="mt-1 text-xs text-ds-ink-muted">Capture pallet, rack, stack, roll reference, count, weight and receiving remarks.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-ds-ink-muted">
                Pallet Number
                <input value={palletRow?.palletId ?? ''} onChange={(e) => updateRow(palletRowId, { palletId: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" placeholder="Pallet / stack / roll ID" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Pallet Count
                <input type="number" min={0} value={palletRow?.palletCount ?? ''} onChange={(e) => updateRow(palletRowId, { palletCount: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Weight
                <input type="number" min={0} step="any" value={palletRow?.palletWeight ?? ''} onChange={(e) => updateRow(palletRowId, { palletWeight: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Mill Date
                <input type="date" value={palletRow?.millDate ?? ''} onChange={(e) => updateRow(palletRowId, { millDate: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted sm:col-span-2">
                Remarks
                <input value={palletRow?.remarks ?? ''} onChange={(e) => updateRow(palletRowId, { remarks: e.target.value })} className="mt-1 w-full rounded border border-ds-line/60 bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setPalletRowId(null)} className="rounded bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink">Done</button>
            </div>
          </div>
        </div>
      ) : null}

      <GrnAllocationPrompt
        open={allocationPromptOpen}
        grnMovementId={allocationGrnId}
        materialCode={allocationMaterialCode}
        receivedQty={allocationReceivedQty}
        matches={allocationMatches}
        onClose={() => setAllocationPromptOpen(false)}
        onAllocated={() => {
          toast.success('GRN allocated to shortage')
          setAllocationPromptOpen(false)
        }}
      />
    </div>
  )
}
