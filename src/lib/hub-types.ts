/** URL segment for `/hub/[toolType]` */
export const HUB_TOOL_TYPES = ['plates', 'dies', 'blocks', 'shade_cards'] as const
export type HubToolType = (typeof HUB_TOOL_TYPES)[number]

export function parseHubToolType(raw: string | undefined): HubToolType | null {
  if (!raw) return null
  return HUB_TOOL_TYPES.includes(raw as HubToolType) ? (raw as HubToolType) : null
}

export type VendorPipelineStage = 'po_raised' | 'in_production' | 'dispatched' | 'received_triage'

const VENDOR_LABELS: Record<VendorPipelineStage, string> = {
  po_raised: 'PO Raised',
  in_production: 'In Production',
  dispatched: 'Dispatched',
  received_triage: 'Received / Triage',
}

export function vendorStageLabel(s: VendorPipelineStage): string {
  return VENDOR_LABELS[s]
}

/** Map heterogeneous requirement statuses to a vendor pipeline stage for UI. */
export function mapStatusToVendorStage(
  status: string,
  triageChannel?: string | null,
): VendorPipelineStage {
  const s = (status || '').toLowerCase()
  const ch = (triageChannel || '').toLowerCase()
  if (ch.includes('vendor') || s.includes('awaiting_vendor') || s.includes('vendor_procurement')) {
    return 'po_raised'
  }
  if (s.includes('dispatch') || s.includes('shipped')) return 'dispatched'
  if (s.includes('ctp') || s.includes('production') || s.includes('burn')) return 'in_production'
  if (s.includes('received') || s.includes('triage') || s === 'pending' || s.includes('ready')) {
    return 'received_triage'
  }
  return 'po_raised'
}

export type HubIncomingUnified = {
  id: string
  toolType: HubToolType
  code: string
  title: string
  subtitle: string | null
  /** New tools / qty context */
  newLabel: string | null
  vendorStage: VendorPipelineStage
  /** Die-specific */
  lengthMm?: number | null
  widthMm?: number | null
  heightMm?: number | null
  ups?: number | null
  /** Block-specific */
  embossingLeafing?: string | null
  /** Shade-specific */
  approvalDate?: string | null
  masterArtworkRef?: string | null
  /** Shade procurement — physical sample not yet matched */
  physicalSampleAwaiting?: boolean
  /** Raw for actions */
  raw: Record<string, unknown>
}
