// src/lib/rbac.ts
// Role-based access control for the 5 canonical plant roles.

export const ROLE_SLUGS = [
  'admin',
  'plant_head',
  'accounts',
  'design_planning',
  'production',
] as const

export type RoleSlug = (typeof ROLE_SLUGS)[number]

export const ROLE_LABELS: Record<RoleSlug, string> = {
  admin: 'Admin',
  plant_head: 'Plant Head',
  accounts: 'Accounts',
  design_planning: 'Design & Planning',
  production: 'Production',
}

/** Granular module/access keys used to gate nav + API routes. */
export type ModuleKey =
  | 'customer_po'
  | 'paper_warehouse'
  | 'planning'
  | 'artwork_queue'
  | 'job_cards'
  | 'cutting'
  | 'printing'
  // full-system-only modules (admin / plant_head)
  | 'tooling_hub'
  | 'inventory'
  | 'stores'
  | 'quality'
  | 'dispatch'
  | 'reports'
  | 'masters'
  | 'settings'

const FULL = '*' as const

/** Role → modules. '*' means full system (every module). */
export const ROLE_MODULES: Record<RoleSlug, ModuleKey[] | typeof FULL> = {
  admin: FULL,
  plant_head: FULL,
  accounts: ['customer_po', 'paper_warehouse'],
  design_planning: ['customer_po', 'planning', 'artwork_queue', 'job_cards', 'cutting', 'printing'],
  production: ['cutting', 'printing'],
}

function normalize(role: string | undefined | null): RoleSlug | null {
  const r = (role ?? '').trim().toLowerCase()
  return (ROLE_SLUGS as readonly string[]).includes(r) ? (r as RoleSlug) : null
}

export function roleHasFullSystem(role: string | undefined | null): boolean {
  const slug = normalize(role)
  return slug != null && ROLE_MODULES[slug] === FULL
}

export function hasModuleAccess(role: string | undefined | null, moduleKey: ModuleKey): boolean {
  const slug = normalize(role)
  if (!slug) return false
  const mods = ROLE_MODULES[slug]
  if (mods === FULL) return true
  return mods.includes(moduleKey)
}

/** Roles that may reach a given module — for `requireRole`-style API gates. */
export function rolesWithModule(moduleKey: ModuleKey): RoleSlug[] {
  return ROLE_SLUGS.filter((s) => hasModuleAccess(s, moduleKey))
}
