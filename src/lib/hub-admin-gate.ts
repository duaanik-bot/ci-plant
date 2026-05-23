import { roleHasFullSystem } from '@/lib/rbac'

/** Tooling Hub staff / settings — full-system roles only (admin, plant_head). */
export function isHubStaffAdmin(role: string | undefined): boolean {
  return roleHasFullSystem(role)
}
