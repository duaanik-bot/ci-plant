// Sets up the Finance books: the books for Colour Impressions (CI) and Darbi Print Pack (DP), financial year
// 2026-27 with its months, Tally's group tree, the Cash and Profit & Loss A/c ledgers, the default approval
// rules, and Finance access for the MD and Accounts. Spec §16 step 6.
//
//   FIN_SETUP_ACCOUNTANT_EMAIL=<the Accounts login's email> node scripts/finance-setup.mjs --apply
//
//   node scripts/finance-setup.mjs                  dry run against $DATABASE_URL (default: the local database)
//   node scripts/finance-setup.mjs --apply          write it
//   node scripts/finance-setup.mjs --apply --prod   write it to a database that is not local
//
// Everything runs in ONE transaction that is rolled back unless --apply is given, so a dry run reports exactly
// what --apply would do and leaves nothing behind (identity counters do move; rolled-back inserts always
// use them up). Safe to run again: a book that exists is left alone, and a login that already has access
// only gains roles it lacks. See server/src/finance-setup.js.
//
// The Accounts login's email is not kept in this repository, which is public (ruling R68): it is read from
// FIN_SETUP_ACCOUNTANT_EMAIL. --apply refuses to run without it; a dry run without it grants the MD alone and
// says so. The MD's login is named in server/src/finance-setup.js (FIN_SETUP_GRANTS).
//
// The run prints, for every grant on every book, what it did: added, changed (and how), or unchanged.
// RUNBOOK: a re-run RESTORES a default grant that was revoked since the last run. Revoking deletes the grant,
// so the run finds none and adds it again, and prints "added" for it. To keep it revoked, revoke it again in
// the app (Finance → Setup → Access) after the re-run, or take it out of FIN_SETUP_GRANTS before running.
//
// A database that is not on localhost / 127.0.0.1 is refused unless --prod is also passed, before any
// connection is made. The host judged is the one pg will really connect to, read from the client it builds:
// a URL's ?host= parameter overrides the host before the '@', and PGHOST stands in when the URL names none.
// --prod does not make a run write: --apply still decides that.
//
// The logic lives in server/src/finance-setup.js and is handed this script's own transaction client as qc /
// oc, built the way tx() builds them. Neither file loads server/src/db.js: it would open its own pool
// and install number parsers that change how every numeric in this run is read.
import pg from 'pg';

const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
// The URL as it is shown, never with the password. Parsed rather than pattern-matched, so a password that
// holds an unencoded '@' or ':' is still hidden whole.
const shown = (() => {
  try { const u = new URL(url); if (u.password) u.password = '***'; return u.href; } catch { return '(DATABASE_URL could not be read)'; }
})();

// The client, built before anything else and not yet connected, so the host it will connect to is the one judged: pg reads the
// host from more than the part of the URL before the port (a ?host= parameter wins, and PGHOST fills in for a URL that names
// none). A URL pg cannot read at all makes no client, and is no local database.
const client = (() => {
  try {
    return new pg.Client({
      connectionString: url,
      ssl: /supabase|amazonaws|render|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  } catch { return null; }
})();
const host = typeof client?.host === 'string' && client.host ? client.host.toLowerCase() : null;
const LOCAL = host === 'localhost' || host === '127.0.0.1';

// The Accounts login's email, from the environment: trimmed, and one '@' with something on either side and no spaces.
const accountant = (process.env.FIN_SETUP_ACCOUNTANT_EMAIL ?? '').trim();
const EMAIL = /^[^\s@]+@[^\s@]+$/;

// Node gives the AggregateError it throws an empty message when every address it tried refused the connection.
const whyOf = e => [e.message, ...(e.errors ?? []).map(x => x.message)].filter(Boolean).join('; ') || e.code || String(e);

// What a run did to a grant on a book, in words: "added", "changed (roles added: viewer; export switched off)", "unchanged".
function outcomeText(b, would) {
  if (b.outcome === 'unchanged') return 'unchanged';
  if (b.outcome === 'added') return `${would}added`;
  const how = [];
  if (b.changed?.roles_added?.length) how.push(`roles added: ${b.changed.roles_added.join(', ')}`);
  if (b.changed?.can_export) how.push(`export switched ${b.changed.can_export.to ? 'on' : 'off'}`);
  return `${would}changed (${how.join('; ')})`;
}

async function main() {
  if (!LOCAL && !PROD) {
    console.error('Refusing a non-local database without --prod');
    console.error(`  host: ${host ?? '(no host could be read from DATABASE_URL)'}`);
    process.exitCode = 1;
    return;
  }
  if (accountant && !EMAIL.test(accountant)) {
    console.error(`FIN_SETUP_ACCOUNTANT_EMAIL is not an email address: "${accountant}". Set it to the Accounts login's email.`);
    process.exitCode = 1;
    return;
  }
  if (APPLY && !accountant) {
    console.error('Refusing --apply: FIN_SETUP_ACCOUNTANT_EMAIL is not set. It is the email of the Accounts login, which this repository '
      + 'does not keep; set it to that login\'s email and run again.');
    process.exitCode = 1;
    return;
  }

  const { finSetupBooks, finSetupGrants } = await import(new URL('../server/src/finance-setup.js', import.meta.url).href);
  const grants = finSetupGrants(accountant);

  try {
    await client.connect();
  } catch (e) {
    console.error(`Could not connect to ${host ?? 'the database'}: ${whyOf(e)}`);
    process.exitCode = 1;
    return;
  }

  const qc = async (text, params = []) => (await client.query(text, params)).rows;
  const oc = async (text, params = []) => ((await client.query(text, params)).rows[0] ?? null);

  let result, books, access;
  try {
    await client.query('BEGIN');
    result = await finSetupBooks(qc, oc, { grants });

    // Read back inside the transaction, so a dry run shows what it would have written. COUNT is cast: without
    // db.js's parsers a bigint arrives as a string.
    const codes = result.books.map(b => b.code);
    books = await qc(
      `SELECT b.code, b.name, b.books_begin,
              (SELECT COUNT(*)::int FROM fin_groups g WHERE g.book_id = b.id) AS groups,
              (SELECT COUNT(*)::int FROM fin_ledgers l WHERE l.book_id = b.id) AS ledgers,
              (SELECT COUNT(*)::int FROM fin_approval_rules r WHERE r.book_id = b.id) AS rules,
              (SELECT COUNT(*)::int FROM fin_periods p WHERE p.book_id = b.id AND p.status = 'before_books') AS before_books,
              (SELECT COUNT(*)::int FROM fin_periods p WHERE p.book_id = b.id AND p.status = 'open') AS open_months
         FROM fin_books b WHERE b.code = ANY($1::text[])`, [codes]);
    access = [];
    for (const g of grants) {
      const rows = await qc(
        `SELECT b.code, a.roles FROM fin_access a
           JOIN users u ON u.id = a.user_id JOIN fin_books b ON b.id = a.book_id
          WHERE lower(u.email) = lower($1) AND u.active = 1 AND b.code = ANY($2::text[]) ORDER BY b.code`, [g.email, g.books]);
      access.push(rows);
    }
    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\nRolled back — nothing was written.\n${e.message}`);
    process.exitCode = 1;
    return;
  } finally {
    await client.end();
  }

  const would = APPLY ? '' : 'would be ';
  const nameW = Math.max(...books.map(r => r.name.length));
  console.log(`\nDatabase  ${shown}`);
  console.log(`Mode      ${APPLY ? (LOCAL ? 'apply' : 'apply to a NON-LOCAL database (--prod)') : 'dry run'}`);
  console.log(`Accounts  ${accountant
    ? `${accountant}, from FIN_SETUP_ACCOUNTANT_EMAIL`
    : 'not set: FIN_SETUP_ACCOUNTANT_EMAIL is empty, so this dry run grants the MD alone, and --apply will refuse until it is set.'}`);
  console.log('\nBooks');
  for (const b of result.books) {
    const row = books.find(r => r.code === b.code);
    const status = b.created ? `${would}created` : 'already set up';
    console.log(`  ${b.code.padEnd(4)}${row.name.padEnd(nameW)}  ${status.padEnd(18)}`
      + `${row.groups} groups, ${row.ledgers} ledgers, ${row.rules} rules, ${row.before_books + row.open_months} months `
      + `(${row.before_books} before the books, ${row.open_months} open), books begin ${row.books_begin}`);
  }

  // Access: a line per grant per book, with the roles the login holds there now and what this run did to the grant.
  console.log('\nAccess');
  const lines = [];                                          // [email, code, roles, outcome] or [email, message]
  grants.forEach((g, i) => {
    const done = result.grants[i];
    if (!done.found) {
      lines.push([g.email, `NOT FOUND: no active login has this email, so nothing ${APPLY ? 'was' : 'would be'} granted`]);
      return;
    }
    for (const b of done.books) {
      const roles = access[i].find(r => r.code === b.code)?.roles ?? [];
      lines.push([g.email, b.code, roles.join(', '), outcomeText(b, would)]);
    }
  });
  const emailW = Math.max(...lines.map(l => l[0].length));
  const rolesW = Math.max(...lines.filter(l => l.length === 4).map(l => l[2].length), 0);
  for (const line of lines) {
    console.log(line.length === 4
      ? `  ${line[0].padEnd(emailW)}  ${line[1].padEnd(4)}${line[2].padEnd(rolesW)}  ${line[3]}`
      : `  ${line[0].padEnd(emailW)}  ${line[1]}`);
  }

  const missing = grants.filter((g, i) => !result.grants[i].found).map(g => g.email);
  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write it.');
  } else {
    console.log('\nApplied.');
    if (missing.length) {
      console.log(`${missing.length} login${missing.length === 1 ? '' : 's'} not found (${missing.join(', ')}). Create ${missing.length === 1 ? 'it' : 'them'} `
        + 'in the ERP, then run this again with --apply: it only adds what is missing.');
    }
  }
}

await main();
