// One source of truth for per-user module access.
// users.modules is NULL (= every module the role allows, the original
// behaviour) or an array of these keys. Admins always see everything —
// module restriction is for handing a focused slice of the ERP to a user.
export const MODULES = [
  { key: 'dashboard', label: 'Dashboard', path: '/' },
  { key: 'track', label: 'Tracking', path: '/track' },
  { key: 'orders', label: 'Sales Orders', path: '/orders' },
  { key: 'invoices', label: 'Invoices', path: '/invoices' },
  { key: 'accounts', label: 'Accounts', path: '/accounts' },
  { key: 'dispatch', label: 'Dispatch', path: '/dispatch' },
  { key: 'planning', label: 'Planning', path: '/planning' },
  { key: 'artwork', label: 'Artwork', path: '/artwork' },
  { key: 'production', label: 'Job Cards', path: '/production' },
  { key: 'print_planning', label: 'Print Planning', path: '/print-planning' },
  { key: 'floor', label: 'Live Floor', path: '/floor' },
  { key: 'extra_sheets', label: 'Extra Sheets', path: '/extra-sheets' },
  { key: 'finished_goods', label: 'Finished Goods', path: '/finished-goods' },
  { key: 'procurement', label: 'Procurement', path: '/procurement' },
  { key: 'inventory', label: 'Warehouse', path: '/inventory' },
  { key: 'reports', label: 'Reports', path: '/reports' },
  { key: 'masters', label: 'Masters', path: '/masters' },
  { key: 'tooling', label: 'Tooling Hub', path: '/tooling' },
];

// Can this user open this module? NULL/undefined modules = unrestricted.
export function canAccess(user, moduleKey) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.modules == null) return true;
  return user.modules.includes(moduleKey);
}

// Which module does a pathname belong to? Longest matching path wins,
// so /print-planning doesn't fall through to a shorter prefix.
export function moduleForPath(pathname) {
  const hit = [...MODULES]
    .sort((a, b) => b.path.length - a.path.length)
    .find(m => (m.path === '/' ? pathname === '/' : pathname === m.path || pathname.startsWith(m.path + '/')));
  return hit?.key ?? null;
}

// First place this user is allowed to land after login / a blocked route.
export function firstAllowedPath(user) {
  const m = MODULES.find(x => canAccess(user, x.key));
  return m?.path ?? '/login';
}
