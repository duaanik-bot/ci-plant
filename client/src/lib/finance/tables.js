// The tables a Finance screen listens to for live refresh: useRealtimeRefresh(load, FINANCE_TABLES). When another login
// posts, approves or changes a setting, one of these changes and the database announces it (every fin_* table carries
// the realtime triggers of its Finance migration). A table missing here is a screen that goes stale without a sound, so
// server/src/finance-wiring.test.js holds this list to the tables the two Finance migrations create.
//
// Pure ESM, no React, no DOM, no imports.

export const FINANCE_TABLES = Object.freeze([
  // 20261027104320_finance_ledger_core.sql
  'fin_books', 'fin_years', 'fin_periods', 'fin_groups', 'fin_ledgers',
  'fin_vouchers', 'fin_voucher_lines',
  'fin_access', 'fin_approval_rules', 'fin_audit_log',
  'fin_imports', 'fin_import_ledgers', 'fin_import_bills',
  // 20261121090100_finance_cash_bank.sql
  'fin_allocations', 'fin_cash_counts',
  'fin_ledger_roles', 'fin_hr_channels', 'fin_hr_expense_map', 'fin_book_settings', 'fin_hr_exceptions', 'fin_hr_covers',
]);
