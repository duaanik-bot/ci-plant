export type Axis = number | null
export type Dims = { l: Axis; w: Axis; h: Axis }

export type VarianceResult = {
  variance: { l: Axis; w: Axis; h: Axis }
  maxAbsVariance: number
  sizeMismatch: boolean
}

export function computeVariance(
  spec: Dims,
  physical: Dims,
  tolMm = 2,
): VarianceResult {
  const axisVar = (s: Axis, p: Axis): Axis =>
    s == null || p == null ? null : Number((p - s).toFixed(2))

  const variance = {
    l: axisVar(spec.l, physical.l),
    w: axisVar(spec.w, physical.w),
    h: axisVar(spec.h, physical.h),
  }
  const abs = [variance.l, variance.w, variance.h]
    .filter((v): v is number => v != null)
    .map((v) => Math.abs(v))
  const maxAbsVariance = abs.length ? Math.max(...abs) : 0
  return { variance, maxAbsVariance, sizeMismatch: maxAbsVariance > tolMm }
}
