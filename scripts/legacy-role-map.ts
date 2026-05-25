/**
 * Legacy (Colour Impressions PHP app) role names → canonical RBAC slugs.
 *
 * The whole app gates access on the five canonical slugs created by prisma/seed.ts:
 *   admin, plant_head, accounts, design_planning, production
 *
 * Legacy CSV exports carry free-text role names like "Admin" / "Plant Head" /
 * "Printing" which match none of those gates, so every imported user gets
 * locked out of Masters, HR and ~30 role-gated API routes. Import scripts MUST
 * translate through this table so users land on a real RBAC role.
 */
export const LEGACY_ROLE_MAP: Record<string, string> = {
  root: 'admin',
  Admin: 'admin',
  'Plant Head': 'plant_head',
  Manager: 'plant_head',
  Designer: 'design_planning',
  artwork: 'design_planning',
  Deigntopasting: 'design_planning',
  Desintojobcard: 'design_planning',
  Printing: 'production',
  Cutting: 'production',
  Coating: 'production',
  Lamination: 'production',
  Embossing: 'production',
  Leafing: 'production',
  'Spot UV': 'production',
  'Dye Cutting': 'production',
  'Dye Breaking': 'production',
  Pasting: 'production',
  PO: 'accounts',
  Billing: 'accounts',
  Store: 'accounts',
  'Gate Keeper': 'accounts',
  Dispatch: 'accounts',
}

/** Specific people whose canonical role must outrank their legacy CSV role. */
export const USER_ROLE_OVERRIDES: Record<string, string> = {
  'ravi@ci.local': 'admin',
}

/** Conservative floor for any legacy role not in the table above. */
export const FALLBACK_ROLE_SLUG = 'production'

export function canonicalRoleSlug(legacyName: string): string {
  return LEGACY_ROLE_MAP[legacyName] ?? FALLBACK_ROLE_SLUG
}
