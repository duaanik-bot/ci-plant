/** Default pre-press audit owner for PO line specs and hub compliance. */
export const DEFAULT_PREPRESS_AUDIT_LEAD = 'Anik Dua' as const

/** Ensures `prePressAuditLead` is set when missing (new or legacy lines). */
export function withDefaultPrePressAuditLead(
  spec: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged = {
    ...(spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {}),
  }
  const v = merged.prePressAuditLead
  if (v == null || (typeof v === 'string' && !v.trim())) {
    merged.prePressAuditLead = DEFAULT_PREPRESS_AUDIT_LEAD
  }
  return merged
}
