/**
 * Seller (Colour Impressions) company profile used on every tax invoice.
 *
 * Pulled from env vars so a future multi-tenant or staging deploy can override
 * without code changes. Defaults match the registered office on record.
 *
 * Read this once at the top of any module that needs seller identity — values
 * are stable for the process lifetime.
 */
export const COMPANY = {
  legalName: process.env.COMPANY_LEGAL_NAME ?? 'COLOUR IMPRESSIONS PVT. LTD.',
  shortCode: process.env.COMPANY_SHORT_CODE ?? 'CI',
  gstin: process.env.COMPANY_GSTIN ?? '',
  pan: process.env.COMPANY_PAN ?? '',
  /// 2-digit Indian state code where the company is registered. Used to decide
  /// CGST+SGST (intra-state) vs IGST (inter-state) for every invoice.
  stateCode: process.env.COMPANY_STATE_CODE ?? '27', // Maharashtra default.
  stateName: process.env.COMPANY_STATE_NAME ?? 'Maharashtra',
  addressLine1: process.env.COMPANY_ADDRESS_LINE_1 ?? '',
  addressLine2: process.env.COMPANY_ADDRESS_LINE_2 ?? '',
  city: process.env.COMPANY_CITY ?? '',
  pincode: process.env.COMPANY_PINCODE ?? '',
  phone: process.env.COMPANY_PHONE ?? '',
  email: process.env.COMPANY_EMAIL ?? '',
  /// Bank details for the invoice footer.
  bankName: process.env.COMPANY_BANK_NAME ?? '',
  bankBranch: process.env.COMPANY_BANK_BRANCH ?? '',
  bankAccount: process.env.COMPANY_BANK_ACCOUNT ?? '',
  bankIfsc: process.env.COMPANY_BANK_IFSC ?? '',
} as const

/// Pretty-print the seller block for invoice headers.
export function companyAddressLines(): string[] {
  const out: string[] = []
  if (COMPANY.addressLine1) out.push(COMPANY.addressLine1)
  if (COMPANY.addressLine2) out.push(COMPANY.addressLine2)
  const cityLine = [COMPANY.city, COMPANY.pincode].filter(Boolean).join(' ')
  if (cityLine) out.push(cityLine)
  if (COMPANY.stateName) out.push(`${COMPANY.stateName} (State Code: ${COMPANY.stateCode})`)
  return out
}
