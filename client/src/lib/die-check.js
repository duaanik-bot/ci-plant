// How the size check names a die from the die list (die_register). The owner, 15 Nov 2026: the list's numbers are
// not written on the dies — so a die is called by the job it was made for where one is recorded, each line says where
// the die is known from (the 2024 die list, or a drawing in the studio's Drive), and facts that were never recorded
// are left out rather than shown as "not recorded".
import { styleLabel } from './costing.js';

const REGISTER = 'DIE DATA 2024';
const FROM = Object.freeze({
  'DRIVE NEW DIE': 'new-die drawing in Drive',
  'DRIVE DIE LINE': 'die line in Drive',
  'DRIVE OLD DIE USE': 'old-die job file in Drive', // a job file marked OLD DIE: the job may be the one that reused it
});
const jobOf = d => String(d?.job_no ?? '').trim();

// "Job 12345's die" (a job's second die, J12345/2: "Job 12345's die no. 2"); with no job, the list or die number.
export function dieName(d) {
  const job = jobOf(d), no = String(d?.die_no ?? '');
  if (job) {
    const nth = no.match(/\/(\d+)$/);
    return `Job ${job}'s die${nth ? ` no. ${nth[1]}` : ''}`;
  }
  return d?.source === REGISTER ? `2024 die list no. ${no}` : `Die ${no}`;
}

export function dieFrom(d) {
  if (d?.source === REGISTER) return jobOf(d) ? `2024 die list no. ${d.die_no}` : 'no job no. recorded';
  return FROM[d?.source] || 'in the die list';
}

export function dieFacts(d) {
  const out = [];
  if (d?.style) out.push(styleLabel(d.style));
  if (Number(d?.ups) > 0) out.push(`${Number(d.ups)} up`);
  return out;
}

const mm = x => Number(x).toLocaleString('en-IN', { maximumFractionDigits: 1, useGrouping: false });
export const dieSize = d => [d.l, d.w, d.h].map(mm).join(' × ');

// The "Same numbers, written another way" and "Close dies" lines: size first, then which die —
// "80 × 92 × 66, Job 12345's die no. 2 (die line in Drive, another order)" — at most LISTED, then "+ n more".
export const LISTED = 6;
export const listed = items => items.slice(0, LISTED).join(' · ') + (items.length > LISTED ? ` · + ${items.length - LISTED} more` : '');
export function masterItem(d) {
  const more = [d.ups ? `${d.ups} up` : null, d.other_order ? 'another order' : null].filter(Boolean);
  return `${String(d.carton_size).replace(/x/gi, ' × ')}, Die Master die ${d.code}${more.length ? ` (${more.join(', ')})` : ''}`;
}
export const listItem = (d, ...more) => `${dieSize(d)}, ${dieName(d)} (${[...dieFacts(d), dieFrom(d), ...more].join(', ')})`;

// The costing card's one click for a die only on the die list (owner, 17 Nov 2026): New die stays ticked until somebody
// says the die is still in the rack.
export const noNewDieLabel = d => `No new die — use ${dieName(d)}`;
