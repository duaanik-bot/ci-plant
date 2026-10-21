// First-time setup of the books (spec §6, §16 step 6). For each business it makes the book, the financial
// year the books begin in with its twelve months, Tally's group tree, the two system ledgers and the
// default approval rules; then it gives the first people their Finance access.
//
// It runs on the `qc` / `oc` of a transaction it is handed and imports nothing that reaches the database,
// so one body of code serves the app's tests (db.tx), scripts/finance-setup.mjs (its own pg.Client) and
// the Years screen (finCreateYear). The caller owns BEGIN, COMMIT and ROLLBACK. Nothing here may read a
// numeric or a count without casting it in SQL: the script does not load db.js, so it never gets db.js's
// number parsers, and a NUMERIC or COUNT(*) would arrive as a string.
//
// Re-run safe, in one specific way. A book that already exists is left exactly as it is. Since setup,
// its groups and ledgers may have been renamed, its rules edited and its months locked, so seeding it
// again by name could bring back a group someone renamed or reset a lock. Only access is applied on
// every run, and a grant can add roles but never remove one, and can only tighten `can_export`. Each
// run says what it did to every grant on every book (added, changed and how, or unchanged), so a grant
// it brings back, one revoked since the last run, is never brought back unseen.

import { FIN_GROUP_TEMPLATE, FIN_SYSTEM_LEDGERS } from './finance-groups.js';
import { FIN_DEFAULT_RULES, FIN_ROLES } from './finance-rules.js';
import { finAudit } from './finance-audit.js';
import { finFyOf, finMonthsOfFy, finIsValidDate } from '../../client/src/lib/finance/fy.js';
import { finFromPaise } from '../../client/src/lib/finance/money.js';

// The two books (spec §6.1). `entity_name` is the billing entity the book belongs to, found by name.
export const FIN_SETUP_BOOKS = Object.freeze([
  Object.freeze({ code: 'CI', name: 'Colour Impressions', entity_name: 'Colour Impressions' }),
  Object.freeze({ code: 'DP', name: 'Darbi Print Pack', entity_name: 'Darbi Print Pack' }),
]);

// The first grants (spec §16 step 6), by email and book code. `can_export` is optional and defaults to true. The MD's login is
// named here: its address is already public in the repository's tracked files.
export const FIN_SETUP_GRANTS = Object.freeze([
  Object.freeze({ email: 'md@motionci.com', roles: Object.freeze(['approver', 'admin']), books: Object.freeze(['CI', 'DP']) }),
]);

// The Accounts login's grant, without its email (ruling R68): the repository is public, and that address is in none of its tracked
// files, so this branch must not be the first to publish it. scripts/finance-setup.mjs takes it from FIN_SETUP_ACCOUNTANT_EMAIL at
// go-live, and --apply refuses without it.
export const FIN_SETUP_ACCOUNTANT = Object.freeze({ roles: Object.freeze(['accountant']), books: Object.freeze(['CI', 'DP']) });

// Every first grant: the MD's, and the Accounts login's when its email is given (trimmed). No email is the MD's alone.
export function finSetupGrants(accountantEmail) {
  const email = typeof accountantEmail === 'string' ? accountantEmail.trim() : '';
  return email ? [...FIN_SETUP_GRANTS, { email, ...FIN_SETUP_ACCOUNTANT }] : [...FIN_SETUP_GRANTS];
}

// Only year-end closing posts to Profit & Loss A/c (SP3), so no hand-typed voucher may use it (spec §6.4).
const SYSTEM_ONLY_LEDGERS = new Set(['Profit & Loss A/c']);

// Who is acting, the way the audit log wants it. Setup passes a name ('system (go-live)'); a screen passes
// the signed-in user as { id, name }.
function actorOf(actor) {
  const name = typeof actor === 'string' ? actor : actor?.name;
  if (typeof name !== 'string' || !name.trim()) throw new Error('Setup needs to know who is acting: pass a name or { id, name }');
  return { id: typeof actor === 'object' ? (actor.id ?? null) : null, name: name.trim() };
}

// Adds one financial year to a book, with its twelve months. A month that ends before `booksBegin` is
// `before_books` and the rest are `open` (spec §6.2), so a year entirely after the books begin is all open
// and one entirely before is all before_books. The month the books begin in is open even when they begin
// part-way through it. Idempotent on (book_id, start_date): a year that exists is returned as it is, its
// months untouched, and nothing is written. `actor` is a name or { id, name }.
//
// Returns { year, created }, where year is the fin_years row with its fin_periods rows (oldest first) as
// `periods`. A year that was created is audited here (entity 'year', action 'create'); a caller does not.
export async function finCreateYear(qc, oc, { bookId, label, booksBegin, actor }) {
  const months = finMonthsOfFy(label);            // refuses anything that is not a real financial year
  if (!finIsValidDate(booksBegin)) throw new Error(`"${booksBegin}" is not a date; write books_begin as YYYY-MM-DD`);
  const by = actorOf(actor);
  const fy = finFyOf(months[0].start_date);

  let year = await oc(
    `INSERT INTO fin_years (book_id, label, short, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (book_id, start_date) DO NOTHING
     RETURNING id, book_id, label, short, start_date, end_date`,
    [bookId, fy.label, fy.short, fy.start, fy.end]);
  const created = year !== null;
  year ??= await oc(
    'SELECT id, book_id, label, short, start_date, end_date FROM fin_years WHERE book_id = $1 AND start_date = $2',
    [bookId, fy.start]);

  const periods = [];
  if (created) {
    for (const m of months) {
      periods.push(await oc(
        `INSERT INTO fin_periods (book_id, year_id, month_no, label, start_date, end_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, book_id, year_id, month_no, label, start_date, end_date, status, status_changed_by, status_changed_at`,
        [bookId, year.id, m.month_no, m.label, m.start_date, m.end_date, m.end_date < booksBegin ? 'before_books' : 'open']));
    }
    await finAudit(qc, {
      bookId, entity: 'year', entityId: year.id, action: 'create', userId: by.id, userName: by.name,
      after: {
        label: year.label, short: year.short, start_date: year.start_date, end_date: year.end_date,
        before_books: periods.filter(p => p.status === 'before_books').length, open: periods.filter(p => p.status === 'open').length,
      },
    });
  } else {
    periods.push(...await qc(
      `SELECT id, book_id, year_id, month_no, label, start_date, end_date, status, status_changed_by, status_changed_at
         FROM fin_periods WHERE year_id = $1 ORDER BY start_date`, [year.id]));
  }
  return { year: { ...year, periods }, created };
}

// Sets up the books and the first grants. Pass `books` and `grants` to set up something other than the two
// businesses and the MD's login (the script passes finSetupGrants, with the Accounts login's email from
// its environment); `actor` is a name or { id, name }, written to the audit log and to created_by /
// granted_by (of a grant it makes) / updated_by.
//
// - A book is made when no book has its code. Its billing entity is found by name, ignoring case, and it
//   is an error if none is, or if the name fits more than one. A book that exists is skipped (see the top).
// - Each grant finds its login by email, ignoring case, among active logins only (an inactive login cannot
//   sign in, and finGrantAccess refuses one too). `found` says whether it did; an email nobody has is
//   reported and skipped, never an error. A grant's `books` are codes, and each must be one of `books`.
// - A grant for a user who already has a row on a book takes the union of the roles and ANDs the
//   can_export flags, so a re-run can add a role and can never switch exporting back on. It keeps the
//   granted_by it had. Each grant found says, per book, what was done to it (applyGrant).
// - The audit log gets one row for each book made (entity 'book', action 'setup', the counts in `after`),
//   one for its year (see finCreateYear), and one for each grant that is new or changed.
//
// The date, the actor and every grant are checked before the first write, so a typo in a role or a book code
// stops the run at once. What can only be found out along the way (a billing entity that is not there) is
// thrown from the middle of the run, and it is the caller's transaction that then leaves nothing behind.
export async function finSetupBooks(qc, oc, {
  booksBegin = '2027-01-01', books = FIN_SETUP_BOOKS, grants = FIN_SETUP_GRANTS, actor = 'system (go-live)',
} = {}) {
  const who = actorOf(actor);
  const fy = finFyOf(booksBegin);                              // the year the books begin in; throws on a bad date
  // Ruling R74: the books begin on the 1st of a month. The Opening voucher is dated the day before, the last day of the month
  // before, and that month ends before the books begin, so it is always before_books (finCreateYear). A day part-way through a
  // month would put the opening in a month of the books.
  if (booksBegin.slice(8) !== '01') {
    throw new Error(`The books begin on the 1st of a month, and ${booksBegin} is not: the Opening voucher is dated the day before they `
      + 'begin, and that day must be the last of a month that comes before the books.');
  }
  const codes = new Set(books.map(b => b.code));
  const asked = grants.map(g => grantOf(g, codes));

  const ids = new Map();                                       // book code -> id, for the grants
  const made = [];
  for (const b of books) {
    const have = await oc('SELECT id FROM fin_books WHERE code = $1', [b.code]);
    const id = have ? have.id : await createBook(qc, oc, b, { booksBegin, fy, who });
    ids.set(b.code, id);
    made.push({ code: b.code, id, created: !have });
  }
  const given = [];
  for (const g of asked) given.push(await applyGrant(qc, oc, g, ids, who));
  return { books: made, grants: given };
}

// One grant, checked and put in the shape applyGrant wants: roles in the order of FIN_ROLES, books as a
// list of distinct codes, can_export a boolean.
function grantOf(g, codes) {
  const email = typeof g?.email === 'string' ? g.email.trim() : '';
  if (!email) throw new Error('A grant needs an email');
  const asked = Array.isArray(g.roles) ? g.roles : [];
  if (asked.length === 0 || asked.some(r => !FIN_ROLES.includes(r))) {
    throw new Error(`Grant for ${email}: roles must be one or more of ${FIN_ROLES.join(', ')} (got: ${asked.join(', ') || 'none'})`);
  }
  const books = [...new Set(Array.isArray(g.books) ? g.books : [])];
  if (books.length === 0) throw new Error(`Grant for ${email} names no book`);
  const unknown = books.filter(code => !codes.has(code));
  if (unknown.length) {
    throw new Error(`Grant for ${email} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a book' : 'are not books'} being set up`);
  }
  return { email, roles: FIN_ROLES.filter(r => asked.includes(r)), can_export: Boolean(g.can_export ?? true), books };
}

// A new book with everything it starts with. Returns its id.
async function createBook(qc, oc, b, { booksBegin, fy, who }) {
  const entities = await qc('SELECT id, name FROM billing_entities WHERE lower(name) = lower($1) ORDER BY id', [b.entity_name]);
  if (entities.length === 0) throw new Error(`Billing entity "${b.entity_name}" not found`);
  if (entities.length > 1) {
    throw new Error(`Billing entity "${b.entity_name}" matches ${entities.length} rows (${entities.map(e => e.name).join(', ')}); `
      + 'rename one so the name picks a single business');
  }
  const book = await oc(
    `INSERT INTO fin_books (code, name, billing_entity_id, books_begin, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [b.code, b.name, entities[0].id, booksBegin, who.name]);

  // The template lists a parent before its sub-groups, so each parent's id is known when its children come.
  const groupIds = new Map();
  for (const g of FIN_GROUP_TEMPLATE) {
    if (g.parent != null && !groupIds.has(g.parent)) throw new Error(`Group "${g.name}" comes before its parent "${g.parent}"`);
    const row = await oc(
      `INSERT INTO fin_groups (book_id, parent_id, name, nature, affects_gross_profit, is_system, sort_order)
       VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
      [book.id, g.parent == null ? null : groupIds.get(g.parent), g.name, g.nature, g.affects_gross_profit, g.sort_order]);
    groupIds.set(g.name, row.id);
  }

  for (const l of FIN_SYSTEM_LEDGERS) {
    if (!groupIds.has(l.group)) throw new Error(`Ledger "${l.name}" names a group that is not in the template: "${l.group}"`);
    await qc(
      `INSERT INTO fin_ledgers (book_id, group_id, name, manual_entry, is_system, created_by)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [book.id, groupIds.get(l.group), l.name, !SYSTEM_ONLY_LEDGERS.has(l.name), who.name]);
  }

  // A rule's limit is NUMERIC in rupees; the rule says paise, and null for every mode that has no limit
  // (the table refuses a limit on any mode but above_limit, and finFromPaise refuses null).
  for (const r of FIN_DEFAULT_RULES) {
    await qc(
      `INSERT INTO fin_approval_rules (book_id, rule_key, mode, limit_amount, updated_by) VALUES ($1, $2, $3, $4, $5)`,
      [book.id, r.rule_key, r.mode, r.limit_paise == null ? null : finFromPaise(r.limit_paise), who.name]);
  }

  const { year } = await finCreateYear(qc, oc, { bookId: book.id, label: fy.label, booksBegin, actor: who });
  await finAudit(qc, {
    bookId: book.id, entity: 'book', entityId: book.id, action: 'setup', userId: who.id, userName: who.name,
    after: {
      code: b.code, name: b.name, billing_entity_id: entities[0].id, books_begin: booksBegin,
      groups: FIN_GROUP_TEMPLATE.length, ledgers: FIN_SYSTEM_LEDGERS.length, rules: FIN_DEFAULT_RULES.length,
      year: year.label, periods: year.periods.length,
    },
  });
  return book.id;
}

// One grant on each book it names. Returns { email, found }, and for a login that was found, `books`: what the run did on each
// book, in the order the grant names them (final review I-5: a re-run used to change grants and say nothing):
//   { code, outcome: 'added' }       there was no grant, so this one was made. A default grant someone revoked is ADDED again by
//                                    a re-run (revoking deletes the row); the setup script's header says what to do about that.
//   { code, outcome: 'changed', changed: { roles_added?: [...], can_export?: { from, to } } }
//                                    roles were added to it, or exporting was switched off; never a role taken away.
//   { code, outcome: 'unchanged' }   it already had all of this.
// A grant that is changed keeps its granted_by: the run only adds to a grant someone gave, and the audit row names the run.
async function applyGrant(qc, oc, g, ids, who) {
  const users = await qc('SELECT id, email FROM users WHERE lower(email) = lower($1) AND active = 1 ORDER BY id', [g.email]);
  if (users.length === 0) return { email: g.email, found: false };
  if (users.length > 1) throw new Error(`More than one login has the email ${g.email}; grant it by hand`);
  const user = users[0];

  const books = [];
  for (const code of g.books) {
    const bookId = ids.get(code);
    const have = await oc('SELECT id, roles, can_export FROM fin_access WHERE user_id = $1 AND book_id = $2 FOR UPDATE', [user.id, bookId]);
    const audit = (entityId, before, after) => finAudit(qc, {
      bookId, entity: 'access', entityId, action: 'grant', userId: who.id, userName: who.name,
      before: before && { user_id: user.id, email: user.email, ...before },
      after: { user_id: user.id, email: user.email, ...after },
    });

    if (!have) {
      const row = await oc(
        `INSERT INTO fin_access (user_id, book_id, roles, can_export, granted_by) VALUES ($1, $2, $3::text[], $4, $5) RETURNING id`,
        [user.id, bookId, g.roles, g.can_export, who.name]);
      await audit(row.id, null, { roles: g.roles, can_export: g.can_export });
      books.push({ code, outcome: 'added' });
      continue;
    }
    const roles = FIN_ROLES.filter(r => have.roles.includes(r) || g.roles.includes(r));
    const canExport = have.can_export && g.can_export;
    const changed = {};
    const added = roles.filter(r => !have.roles.includes(r));
    if (added.length) changed.roles_added = added;
    if (canExport !== have.can_export) changed.can_export = { from: have.can_export, to: canExport };
    if (Object.keys(changed).length === 0) {
      books.push({ code, outcome: 'unchanged' });
      continue;
    }
    await qc('UPDATE fin_access SET roles = $2::text[], can_export = $3, updated_at = now() WHERE id = $1', [have.id, roles, canExport]);
    await audit(have.id, { roles: have.roles, can_export: have.can_export }, { roles, can_export: canExport });
    books.push({ code, outcome: 'changed', changed });
  }
  return { email: g.email, found: true, books };
}
