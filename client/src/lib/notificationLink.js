// Where a notification actually takes you.
//
// Every notification row already knows exactly what it is about: helpers.notify
// stores (ref_table, ref_id) beside the words. But `link` was written as a bare
// page name for the approval kinds — `/planning`, `/extra-sheets` — so clicking
// "Management approval asked — GLISIMET TRIO 2" opened Planning's default queue
// and the reader landed on whatever job happened to sort first. The bell named
// the job and then lost it on the way there.
//
// Two rules, in order:
//   1. A stored link that already NAMES something specific wins. A query string
//      is what "specific" means here: `/floor/printing?q=CI-JC-0159` puts the
//      reader on the right station with the job already searched, and no
//      ref-derived link beats that.
//   2. Otherwise derive from (ref_table, ref_id). Doing it at READ time is what
//      makes this repair reach backwards — every approval notification already
//      sitting in the plant's history carries its ref, so the whole backlog
//      starts landing on the right job the moment this ships, with no UPDATE
//      across the notifications table.
const OF_REF = {
  approval_requests: id => `/planning?ar=${id}`,
  extra_sheet_requests: id => `/extra-sheets?xs=${id}`,
};

export function notificationLink(n) {
  const link = typeof n?.link === 'string' ? n.link.trim() : '';
  if (link.includes('?')) return link;
  // hasOwnProperty, not a bare lookup: ref_table 'constructor' must be an
  // unknown table like any other, not Object.prototype's function. Same guard,
  // same reason as notify-categories.categoryOf.
  const table = typeof n?.ref_table === 'string' ? n.ref_table : '';
  const derive = Object.prototype.hasOwnProperty.call(OF_REF, table) ? OF_REF[table] : null;
  const id = Number(n?.ref_id);
  if (derive && Number.isInteger(id) && id > 0) return derive(id);
  return link || null;
}

export default notificationLink;
