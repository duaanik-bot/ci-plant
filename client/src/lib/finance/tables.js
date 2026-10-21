// The tables a Finance screen listens to for live refresh: useRealtimeRefresh(load, FINANCE_TABLES). When another login
// posts, approves or changes a setting, one of these changes and the database announces it (every fin_* table carries
// the realtime triggers of the Finance migration). A table missing here is a screen that goes stale without a sound, so
// server/src/finance-wiring.test.js holds this list to the tables the migration creates.
//
// Pure ESM, no React, no DOM, no imports.

export const FINANCE_TABLES = Object.freeze([
  'fin_books', 'fin_years', 'fin_periods', 'fin_groups', 'fin_ledgers',
  'fin_vouchers', 'fin_voucher_lines',
  'fin_access', 'fin_approval_rules', 'fin_audit_log',
  'fin_imports', 'fin_import_ledgers', 'fin_import_bills',
]);
