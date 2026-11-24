// The ERP's older doors, pointed at Finance (Cash & Bank spec §11 rows 4 to 6; plan Task 16). On and after the switch date
// (GET /finance/cash/switch) the Invoices page and the Accounts books hand receipts and payments to /finance/cash; before it they
// behave as they always did. Pure ESM, no React, no DOM: the server tests import this file by relative path. Anything unrecognised
// keeps the old door open: a switch date that did not load is "not yet".
import { finCan } from './caps.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Has the day come? Both are 'YYYY-MM-DD', so the text compares as the dates do.
export function finDoorsOpen(switchDate, today) {
  return typeof switchDate === 'string' && typeof today === 'string' && DAY.test(switchDate) && DAY.test(today) && today >= switchDate;
}

// The Finance book of a billing entity, from the books GET /finance/me answers (each carries billing_entity_id): the ERP's one
// mapping (fin_books.billing_entity_id), or null.
export function finBookOfEntity(books, billingEntityId) {
  if (!Array.isArray(books) || billingEntityId == null || billingEntityId === '') return null;
  return books.find(b => b && Number(b.billing_entity_id) === Number(billingEntityId)) ?? null;
}

// May this login record a receipt in the invoice's book? An Accountant or an Approver on it (the 'enter' capability).
export function finMayReceive(books, billingEntityId) {
  const book = finBookOfEntity(books, billingEntityId);
  return Boolean(book) && finCan(book.roles, 'enter');
}
