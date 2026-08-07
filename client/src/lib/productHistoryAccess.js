const PRODUCT_HISTORY_ROUTE_PREFIXES = [
  '/planning',
  '/track',
  '/status-sheet',
  '/artwork',
  '/production',
  '/print-planning',
  '/inventory',
  '/dispatch-invoice',
  '/dispatch',
  '/invoices',
  '/coas',
  '/accounts',
  '/masters',
];

export function canOpenProductHistory(pathname = '') {
  const path = String(pathname).split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return PRODUCT_HISTORY_ROUTE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}
