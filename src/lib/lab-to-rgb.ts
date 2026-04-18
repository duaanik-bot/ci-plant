/** Approximate CIE L*a*b* (D65) → sRGB CSS color for UI swatches. */

export function labToCssColor(L: number, a: number, b: number, fallback = '#27272a'): string {
  if (!Number.isFinite(L) || !Number.isFinite(a) || !Number.isFinite(b)) return fallback
  try {
    const delta = 6 / 29
    const fInv = (t: number) => (t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29))
    const fy = (L + 16) / 116
    const fx = a / 500 + fy
    const fz = fy - b / 200
    const X = 0.95047 * fInv(fx)
    const Y = 1.0 * fInv(fy)
    const Z = 1.08883 * fInv(fz)
    let r = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314
    let g = X * -0.969266 + Y * 1.8760108 + Z * 0.041556
    let bl = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252
    const lin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
    r = lin(r)
    g = lin(g)
    bl = lin(bl)
    const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)))
    return `rgb(${clamp(r)},${clamp(g)},${clamp(bl)})`
  } catch {
    return fallback
  }
}

export function shadeCardDnaColor(opts: {
  labL: number | null | undefined
  labA: number | null | undefined
  labB: number | null | undefined
  colorSwatchHex: string | null | undefined
}): string {
  const hex = opts.colorSwatchHex?.trim()
  if (hex && /^#[0-9A-Fa-f]{6}$/.test(hex)) return hex
  const L = opts.labL
  const a = opts.labA
  const b = opts.labB
  if (L == null || a == null || b == null) return '#27272a'
  return labToCssColor(L, a, b)
}
