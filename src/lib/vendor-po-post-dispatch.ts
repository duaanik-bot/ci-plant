/** Vendor PO has left the mill and may be in GRN / logistics tracking. */
export const VENDOR_PO_POST_DISPATCH_STATUSES = [
  'dispatched',
  'partially_received',
  'fully_received',
] as const

export type VendorPoPostDispatchStatus = (typeof VENDOR_PO_POST_DISPATCH_STATUSES)[number]

export function isVendorPoPostDispatchReceiving(status: string): boolean {
  return (VENDOR_PO_POST_DISPATCH_STATUSES as readonly string[]).includes(status)
}
