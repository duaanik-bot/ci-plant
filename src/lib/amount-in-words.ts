/** Convert an integer rupee amount to Indian-style words. */
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigit(n: number): string {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10)
  const o = n % 10
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`
}

function threeDigit(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  const parts: string[] = []
  if (h > 0) parts.push(`${ONES[h]} Hundred`)
  if (r > 0) parts.push(twoDigit(r))
  return parts.join(' ')
}

/** Indian system: ones-tens (00-99) → hundreds (000) → thousand → lakh → crore. */
export function amountInWords(rupees: number): string {
  if (!Number.isFinite(rupees)) return ''
  const whole = Math.floor(Math.abs(rupees))
  const paise = Math.round((Math.abs(rupees) - whole) * 100)

  if (whole === 0 && paise === 0) return 'Zero Rupees Only'

  const crore = Math.floor(whole / 10_000_000)
  const lakh = Math.floor((whole % 10_000_000) / 100_000)
  const thousand = Math.floor((whole % 100_000) / 1_000)
  const rest = whole % 1_000

  const parts: string[] = []
  if (crore > 0) parts.push(`${twoDigit(crore)} Crore`)
  if (lakh > 0) parts.push(`${twoDigit(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${twoDigit(thousand)} Thousand`)
  if (rest > 0) parts.push(threeDigit(rest))

  let result = parts.join(' ').trim() + ' Rupees'
  if (paise > 0) result += ` and ${twoDigit(paise)} Paise`
  return result + ' Only'
}
