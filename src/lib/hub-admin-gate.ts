/** Tooling Hub staff / settings — coarse role check (matches DB role_name text). */
export function isHubStaffAdmin(role: string | undefined): boolean {
  const r = (role ?? '').toLowerCase()
  return r.includes('admin')
}
