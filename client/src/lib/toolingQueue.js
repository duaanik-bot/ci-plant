// Which tooling requirements are open, in progress, ready, or need attention.
// Pulled out of pages/Tooling.jsx so the rules can be asserted directly: these
// predicates do double duty as the KPI counts AND as the filter behind each
// card, so a wrong one both misreports a number and hides the rows a buyer
// clicked through to find.
//
// Dependency-free on purpose, same reason as lib/requisitionControls.js — this
// module is loaded by `node --test` through server/src/tooling-queue.test.js,
// and a React or browser-only import here would make the suite die on import.
import { dayOf } from './dayOf.js';

// Statuses where the requirement is off the floor's plate — nothing is pending
// on it, so it can neither be open nor overdue.
export const terminal = status => ['ready', 'issued_to_floor', 'returned_to_rack', 'cancelled', 'replaced'].includes(status);

export const REQUEST_KPI = {
  open: r => !terminal(r.status),
  pending: r => r.status === 'pending',
  making: r => ['in_house', 'procurement', 'vendor_assigned', 'sent_to_vendor', 'received_from_vendor', 'grn_completed'].includes(r.status),
  ready: r => ['ready', 'issued_to_floor', 'returned_to_rack'].includes(r.status),
  // dayOf, never toISOString(): before 05:30 IST that reads yesterday, so
  // anything that fell due yesterday compared equal instead of late and dropped
  // out of both the count and the card's filter until the shift was half over.
  // needed_by is a TEXT column holding the plain YYYY-MM-DD a date input wrote,
  // so it is already a local calendar day and both sides now mean the same thing.
  attention: r => r.status === 'lost_damaged' || (!terminal(r.status) && r.needed_by && r.needed_by < dayOf(new Date())),
};
