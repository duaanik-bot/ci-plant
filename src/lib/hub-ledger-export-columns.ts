import { formatDistanceToNow } from 'date-fns'
import type { MasterLedgerRow } from '@/components/hub/MasterLedgerTable'
import type { ToolingLedgerRow } from '@/components/hub/ToolingHubLedgerTable'
import { hubLastActionLine } from '@/lib/hub-card-time'
import { hubPlateSizeCardLine } from '@/lib/plate-size'
import { ledgerRowPlateVolume } from '@/lib/hub-zone-metrics'
import { custodyLabel } from '@/lib/inventory-hub-custody'

export type HubExportColumn<T> = { header: string; getValue: (row: T) => string }

function formatExportTimestamp(iso: string | null | undefined): string {
  if (!iso?.trim()) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatExportDateOnly(iso: string | null | undefined): string {
  if (!iso?.trim()) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function timeInZoneLine(iso: string | null | undefined): string {
  if (!iso?.trim()) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDistanceToNow(d, { addSuffix: true })
}

export function plateMasterLedgerExportColumns(): HubExportColumn<MasterLedgerRow>[] {
  return [
    { header: 'Job ID', getValue: (r) => r.jobId },
    {
      header: 'Carton name',
      getValue: (r) => r.cartonName + (r.partialRemake ? ' (Remake)' : ''),
    },
    { header: 'Artwork code', getValue: (r) => r.artworkCode?.trim() || '—' },
    { header: 'Zone', getValue: (r) => r.zoneLabel },
    { header: 'Workflow status', getValue: (r) => r.statusLabel },
    { header: 'Plate volume', getValue: (r) => String(ledgerRowPlateVolume(r)) },
    { header: 'Plate size', getValue: (r) => hubPlateSizeCardLine(r.plateSize) },
    {
      header: 'Colours',
      getValue: (r) => (r.plateColours?.length ? r.plateColours.join(', ') : '—'),
    },
    { header: 'Last status at', getValue: (r) => formatExportTimestamp(r.lastStatusUpdatedAt) },
    { header: 'Time in zone', getValue: (r) => timeInZoneLine(r.lastStatusUpdatedAt) },
    {
      header: 'Last action',
      getValue: (r) => hubLastActionLine(r.lastStatusUpdatedAt) ?? '—',
    },
  ]
}

export function toolingMasterLedgerExportColumns(): HubExportColumn<ToolingLedgerRow>[] {
  return [
    { header: 'Stable row #', getValue: (r) => (r.ledgerRank != null ? String(r.ledgerRank) : '—') },
    { header: 'Tool / job code', getValue: (r) => r.displayCode },
    { header: 'Title', getValue: (r) => r.title },
    { header: 'L×W×H', getValue: (r) => r.dimensionsLwh?.trim() || '—' },
    { header: 'UPS', getValue: (r) => (r.ups != null ? String(r.ups) : '—') },
    { header: 'Master type', getValue: (r) => r.masterType?.trim() || '—' },
    { header: 'Make', getValue: (r) => (r.dieMake ? r.dieMake : '—') },
    {
      header: 'Similar die codes',
      getValue: (r) =>
        r.similarMatches && r.similarMatches.length > 0
          ? r.similarMatches.map((m) => m.displayCode).join('; ')
          : '—',
    },
    { header: 'DOM (mfg date)', getValue: (r) => formatExportDateOnly(r.dateOfManufacturing) },
    { header: 'Zone', getValue: (r) => r.zoneLabel },
    { header: 'Units', getValue: (r) => String(r.units ?? 0) },
    { header: 'Specifications', getValue: (r) => r.specSummary || '—' },
    { header: 'Last status at', getValue: (r) => formatExportTimestamp(r.lastStatusUpdatedAt) },
    { header: 'Time in zone', getValue: (r) => timeInZoneLine(r.lastStatusUpdatedAt) },
    {
      header: 'Last action',
      getValue: (r) => hubLastActionLine(r.lastStatusUpdatedAt) ?? '—',
    },
  ]
}

export type InventoryDieExportRow = {
  dyeNumber: number
  cartonName: string | null
  cartonSize: string
  ups: number
  location: string | null
  knifeHeightMm: number | null
  impressionCount: number
  custodyStatus: string
  issuedAt?: string | null
  issuedOperator?: string | null
  createdAt?: string | null
}

export function inventoryDieExportColumns(): HubExportColumn<InventoryDieExportRow>[] {
  return [
    { header: 'Job ID (die no.)', getValue: (r) => String(r.dyeNumber) },
    { header: 'Carton name', getValue: (r) => r.cartonName?.trim() || '—' },
    { header: 'Custody status', getValue: (r) => custodyLabel(r.custodyStatus ?? '') },
    { header: 'Carton size (L×W×H)', getValue: (r) => r.cartonSize || '—' },
    { header: 'Ups', getValue: (r) => String(r.ups ?? '—') },
    { header: 'Rack / location', getValue: (r) => r.location?.trim() || '—' },
    { header: 'Knife H (mm)', getValue: (r) => (r.knifeHeightMm != null ? String(r.knifeHeightMm) : '—') },
    { header: 'Impressions', getValue: (r) => String(r.impressionCount ?? 0) },
    { header: 'Issued at', getValue: (r) => formatExportTimestamp(r.issuedAt) },
    { header: 'Issued to (operator)', getValue: (r) => r.issuedOperator?.trim() || '—' },
  ]
}

export type InventoryEmbossExportRow = {
  blockCode: string
  blockType: string
  blockMaterial: string
  cartonName: string | null
  storageLocation: string | null
  impressionCount: number
  custodyStatus: string
  issuedAt?: string | null
  issuedOperator?: string | null
  createdAt?: string | null
}

export function inventoryEmbossExportColumns(): HubExportColumn<InventoryEmbossExportRow>[] {
  return [
    { header: 'Job ID (block code)', getValue: (r) => r.blockCode },
    { header: 'Carton name', getValue: (r) => r.cartonName?.trim() || '—' },
    { header: 'Custody status', getValue: (r) => custodyLabel(r.custodyStatus ?? '') },
    { header: 'Type', getValue: (r) => r.blockType || '—' },
    { header: 'Material', getValue: (r) => r.blockMaterial || '—' },
    { header: 'Rack / storage', getValue: (r) => r.storageLocation?.trim() || '—' },
    { header: 'Impressions', getValue: (r) => String(r.impressionCount ?? 0) },
    { header: 'Issued at', getValue: (r) => formatExportTimestamp(r.issuedAt) },
    { header: 'Issued to (operator)', getValue: (r) => r.issuedOperator?.trim() || '—' },
  ]
}

export type InventoryShadeExportRow = {
  shadeCode: string
  productMaster: string | null
  masterArtworkRef: string | null
  remarks: string | null
  currentHolder?: string | null
  custodyStatus: string
  cardStatusLabel?: string
  locationLabel?: string
  entryDate?: string
  createdAt?: string
  mfgDate?: string | null
  currentAgeMonths?: number | null
}

export function inventoryShadeExportColumns(): HubExportColumn<InventoryShadeExportRow>[] {
  return [
    {
      header: 'MFG date',
      getValue: (r) => r.mfgDate?.trim() || '—',
    },
    {
      header: 'Card age (months)',
      getValue: (r) => (r.currentAgeMonths != null ? String(r.currentAgeMonths) : '—'),
    },
    {
      header: 'Entry date',
      getValue: (r) => r.entryDate ?? (r.createdAt ? r.createdAt.slice(0, 10) : '—'),
    },
    { header: 'Client / product', getValue: (r) => r.productMaster?.trim() || '—' },
    { header: 'AW code', getValue: (r) => r.masterArtworkRef?.trim() || '—' },
    {
      header: 'Card status',
      getValue: (r) =>
        r.cardStatusLabel ??
        (r.custodyStatus === 'in_stock' ? 'In-Stock' : r.custodyStatus === 'on_floor' ? 'Issued' : custodyLabel(r.custodyStatus)),
    },
    {
      header: 'Current location',
      getValue: (r) => {
        if (r.locationLabel) return r.locationLabel
        const status = r.custodyStatus ?? ''
        if (status === 'in_stock') return 'Rack'
        if (status === 'at_vendor') return 'Vendor'
        if (status === 'on_floor') return r.currentHolder?.trim() || 'On floor'
        return '—'
      },
    },
    { header: 'Remarks', getValue: (r) => r.remarks?.trim() || '—' },
    { header: 'Shade card ID', getValue: (r) => r.shadeCode },
  ]
}

/** Whole calendar days from ledger entry date to today (export generation). Excel-only. */
export function leadTimeCalendarDaysFromEntry(entryIso: string | null | undefined): string {
  if (!entryIso?.trim()) return '—'
  const entry = new Date(entryIso)
  if (Number.isNaN(entry.getTime())) return '—'
  const now = new Date()
  const startEntry = Date.UTC(entry.getFullYear(), entry.getMonth(), entry.getDate())
  const startNow = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.floor((startNow - startEntry) / 86400000)
  return String(Math.max(0, days))
}

export function plateMasterLedgerExcelExtraColumns(): HubExportColumn<MasterLedgerRow>[] {
  return [
    {
      header: 'Lead time (calendar days)',
      getValue: (r) => leadTimeCalendarDaysFromEntry(r.ledgerEntryAt),
    },
  ]
}

export function toolingMasterLedgerExcelExtraColumns(): HubExportColumn<ToolingLedgerRow>[] {
  return [
    {
      header: 'Lead time (calendar days)',
      getValue: (r) => leadTimeCalendarDaysFromEntry(r.ledgerEntryAt),
    },
  ]
}

export function inventoryDieExcelExtraColumns(): HubExportColumn<InventoryDieExportRow>[] {
  return [
    {
      header: 'Lead time (calendar days)',
      getValue: (r) => leadTimeCalendarDaysFromEntry(r.createdAt),
    },
  ]
}

export function inventoryEmbossExcelExtraColumns(): HubExportColumn<InventoryEmbossExportRow>[] {
  return [
    {
      header: 'Lead time (calendar days)',
      getValue: (r) => leadTimeCalendarDaysFromEntry(r.createdAt),
    },
  ]
}

export function inventoryShadeExcelExtraColumns(): HubExportColumn<InventoryShadeExportRow>[] {
  return [
    {
      header: 'Lead time (calendar days)',
      getValue: (r) =>
        leadTimeCalendarDaysFromEntry(
          r.createdAt ?? (r.entryDate?.trim() ? `${r.entryDate}T12:00:00.000Z` : null),
        ),
    },
  ]
}
