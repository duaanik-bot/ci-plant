// One source of truth for per-user module access.
// users.modules is NULL (= every module the role allows, the original
// behaviour) or an array of these keys. Admins always see everything —
// module restriction is for handing a focused slice of the ERP to a user.
export const MODULES = [
  { key: 'dashboard', label: 'Dashboard', path: '/' },
  { key: 'track', label: 'Tracking', path: '/track' },
  { key: 'status_sheet', label: 'Status Sheet', path: '/status-sheet' },
  { key: 'orders', label: 'Sales Orders', path: '/orders' },
  { key: 'dispatch_invoice', label: 'Dispatch & Invoice', path: '/dispatch-invoice' },
  { key: 'accounts', label: 'Accounts', path: '/accounts' },
  { key: 'planning', label: 'Planning', path: '/planning' },
  { key: 'artwork', label: 'Artwork', path: '/artwork' },
  { key: 'production', label: 'Job Cards', path: '/production' },
  { key: 'print_planning', label: 'Print Planning', path: '/print-planning' },
  { key: 'floor', label: 'Live Floor', path: '/floor' },
  { key: 'extra_sheets', label: 'Extra Sheets', path: '/extra-sheets' },
  { key: 'cutting_variances', label: 'Cutting Variances', path: '/cutting-variances' },
  { key: 'stage_discrepancies', label: 'Sort & Paste Discrepancies', path: '/stage-discrepancies' },
  { key: 'stock_writeons', label: 'Stock Write-Ons', path: '/stock-writeons' },
  { key: 'logbook', label: 'Logbook', path: '/logbook' },
  { key: 'procurement', label: 'Procurement', path: '/procurement' },
  { key: 'inventory', label: 'Warehouse', path: '/inventory' },
  { key: 'reports', label: 'Reports', path: '/reports' },
  { key: 'masters', label: 'Masters', path: '/masters' },
  { key: 'tooling', label: 'Tooling Hub', path: '/tooling' },
  { key: 'shade_cards', label: 'Shade Cards', path: '/tooling/shade-cards', aliases: ['/shade-cards'] },
];

// Live Floor sub-stations — the 10 production sections a Live-Floor login can be
// dedicated to. users.sections is NULL (= every station) or an array of these
// keys. Mirrors SECTIONS in server/src/routes/floor.js. Sorting + Pasting run as
// one combined station in the app (path /floor/sort-paste).
export const FLOOR_SECTIONS = [
  { key: 'cutting', label: 'Cutting', path: '/floor/cutting' },
  { key: 'printing', label: 'Printing', path: '/floor/printing' },
  { key: 'coating', label: 'Coating', path: '/floor/coating' },
  { key: 'lamination', label: 'Lamination', path: '/floor/lamination' },
  { key: 'foiling', label: 'Foiling', path: '/floor/foiling' },
  { key: 'embossing', label: 'Embossing', path: '/floor/embossing' },
  { key: 'die_cutting', label: 'Die Cutting', path: '/floor/die_cutting' },
  { key: 'sorting', label: 'Sorting', path: '/floor/sort-paste' },
  { key: 'pasting', label: 'Pasting', path: '/floor/sort-paste' },
];

// Who may do planning-side work — Planning, Artwork and Job Cards, including
// every gang / combined-run action. Mirrors PLANNING_ROLES in server/src/auth.js
// and must stay identical to it: this list only decides what the UI offers, and
// offering a button the server refuses is how a user ends up staring at a bare
// "Your role (production) cannot perform this action" toast.
// gang-role-parity.test.js fails the build if the two lists drift apart.
export const PLANNING_ROLES = ['admin', 'planner', 'production'];

// Can this user do planning-side work? The one predicate every gang, planning,
// artwork and job-card control gates on.
export function canPlan(user) {
  return PLANNING_ROLES.includes(user?.role);
}

// Can this user open this module? NULL/undefined modules = unrestricted.
export function canAccess(user, moduleKey) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.modules == null) return true;
  return user.modules.includes(moduleKey);
}

// Can this user open this Live-Floor station? NULL sections = every station.
// Admins and unrestricted logins always pass. Only meaningful once the `floor`
// module is granted — the section list narrows within Live Floor.
export function canAccessSection(user, sectionKey) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.sections == null) return true;
  return user.sections.includes(sectionKey);
}

// Which module does a pathname belong to? Longest matching path wins,
// so /print-planning doesn't fall through to a shorter prefix.
export function moduleForPath(pathname) {
  const hit = [...MODULES]
    .sort((a, b) => b.path.length - a.path.length)
    .find(m => {
      const paths = [m.path, ...(m.aliases || [])];
      return paths.some(path => path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/'));
    });
  return hit?.key ?? null;
}

// First place this user is allowed to land after login / a blocked route.
// An explicit landing_path wins (each login opens straight to its own board);
// otherwise fall back to the first module the user may open.
//
// A landing_path is a convenience, never a grant. Honour it only when the
// account actually holds the module that path belongs to — this function is
// also the target the App.jsx module gate redirects a blocked route to, so
// returning a path the user cannot open bounces them back here forever and
// locks the login out of the whole ERP.
export function firstAllowedPath(user) {
  if (user?.landing_path) {
    const mod = moduleForPath(user.landing_path);
    if (mod == null || canAccess(user, mod)) return user.landing_path;
  }
  const m = MODULES.find(x => canAccess(user, x.key));
  return m?.path ?? '/login';
}
