/** Legacy helper retained for compatibility while customer codes are no longer stored. */
export async function generateCustomerCode(): Promise<string> {
  return `CUST-${Date.now()}`
}
