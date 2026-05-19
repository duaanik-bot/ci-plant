/**
 * Legacy (Colour Impressions PHP app) role names → canonical RBAC slugs.
 *
 * The whole app gates access on the canonical slugs created by prisma/seed.ts
 * (md, operations_head, production_manager, press_operator, qa_officer,
 * qa_manager, stores, procurement_manager, shift_supervisor). Legacy CSV
 * exports carry free-text role names like "Admin" / "Plant Head" / "Printing"
 * which match none of those gates, so every imported user gets locked out of
 * Masters, HR and ~30 role-gated API routes. Import scripts MUST translate
 * through this table so users land on a real RBAC role.
 */
export const LEGACY_ROLE_MAP: Record<string, string> = {
  root: 'md',
  Admin: 'operations_head',
  'Plant Head': 'operations_head',
  Manager: 'production_manager',
  Designer: 'production_manager',
  artwork: 'production_manager',
  Deigntopasting: 'production_manager',
  Desintojobcard: 'production_manager',
  Printing: 'press_operator',
  Cutting: 'press_operator',
  Coating: 'press_operator',
  Lamination: 'press_operator',
  Embossing: 'press_operator',
  Leafing: 'press_operator',
  'Spot UV': 'press_operator',
  'Dye Cutting': 'press_operator',
  'Dye Breaking': 'press_operator',
  Pasting: 'press_operator',
  PO: 'procurement_manager',
  Billing: 'stores',
  Store: 'stores',
  'Gate Keeper': 'stores',
  Dispatch: 'stores',
}

/** Specific people whose canonical role must outrank their legacy CSV role. */
export const USER_ROLE_OVERRIDES: Record<string, string> = {
  'anik@gmail.com': 'md',
}

/** Conservative floor for any legacy role not in the table above. */
export const FALLBACK_ROLE_SLUG = 'press_operator'

export function canonicalRoleSlug(legacyName: string): string {
  return LEGACY_ROLE_MAP[legacyName] ?? FALLBACK_ROLE_SLUG
}
