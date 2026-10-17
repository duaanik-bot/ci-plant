// ─── Names and aliases: the one place the T3-e guards live ──────────────────────────────────────────
// hr/match.js gives a row of the monthly sheet to a person only on firm evidence, and an approved alias is
// one kind of evidence. A spelling that two people could claim would turn that evidence into a guess, so the
// collision is refused where it would be made (Ruling T3-e):
//
//   ALIAS_IS_A_NAME   a spelling saved as an alias may not equal (normName) any person's name or display name
//   NAME_IS_AN_ALIAS  a person's name or display name may not equal (normName) an approved alias that belongs
//                     to somebody else
//
// Anything that writes a name, a display name or an alias takes lockNames(qc) FIRST in its transaction and
// then asks the guard that fits: the people routes, the importer's "save this spelling", the workbook loader.
// The lock is what makes the check worth anything: without it two requests can each pass their check and
// then both write. Every check reads the live rows through `qc`, the query function of the caller's
// transaction (db.js tx()); inside a transaction a pool call would wait on itself on Vercel's one-client pool.
//
// Names are compared as hr/match.js compares them, normName() in JS. Never in SQL: upper() and \s differ
// with the database's locale and encoding, and the importer must agree with this guard to the letter.
//
// A refusal is a 409 with .body = {code}: app.js sends {error: message, ...body} and nothing else.
import { normName } from './match.js';

export const NAMES_LOCK = "SELECT pg_advisory_xact_lock(hashtext('hr.names'))";

function refusal(message, code) {
  const body = { code };
  return Object.assign(new Error(message), { status: 409, body });
}

// First statement of every transaction that writes a name, a display name or an alias.
export async function lockNames(qc) {
  if (typeof qc !== 'function') throw new TypeError('lockNames: pass the transaction query function (qc)');
  await qc(NAMES_LOCK);
}

// 409 ALIAS_IS_A_NAME when `spelling` is, as normName() reads it, the name or the display name of any person
// (the person it is being saved for included). A blank spelling names nobody; the caller refuses it as input.
export async function assertAliasFree(qc, spelling) {
  const wanted = normName(spelling);
  if (wanted === '') return;
  const people = await qc(`SELECT code, name, display_name FROM hr.people ORDER BY id`);
  const named = people.find((p) => normName(p.name) === wanted || normName(p.display_name) === wanted);
  if (named) {
    throw refusal(`${wanted} is the name of ${named.name} (${named.code}), so it cannot also be an alias`, 'ALIAS_IS_A_NAME');
  }
}

// 409 NAME_IS_AN_ALIAS when the name or the display name is an approved alias of a person other than
// `personId` (null for somebody not yet saved). A person's own alias does not count against them.
export async function assertNameFree(qc, { personId = null, name, displayName } = {}) {
  const wanted = [...new Set([name, displayName].map(normName).filter(Boolean))];
  if (!wanted.length) return;
  const [clash] = await qc(
    `SELECT a.alias_norm, p.code, p.name
       FROM hr.person_aliases a JOIN hr.people p ON p.id = a.person_id
      WHERE a.alias_norm = ANY($1::text[]) AND a.person_id IS DISTINCT FROM $2::int
      ORDER BY a.id LIMIT 1`,
    [wanted, personId],
  );
  if (clash) {
    throw refusal(`${clash.alias_norm} is already an approved spelling of ${clash.name} (${clash.code}). `
      + 'Remove that alias first, or use a different name', 'NAME_IS_AN_ALIAS');
  }
}
