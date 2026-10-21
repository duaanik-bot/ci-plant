// One line in Finance's own audit trail (spec §8.3). Every write in Finance appends one, in the same
// transaction as the write, so a change and its record commit or roll back together. The table is
// append-only (spec §7.2), which is why this file only ever inserts.
//
// It takes the transaction's `qc`, never the pool: with one pool client (Vercel), a pool call made inside
// a transaction waits for the client the transaction is holding.
//
// `userId` is users.id, stored bare as everywhere in Finance, and null for an action by the system (setup).
// `before` and `after` are anything JSON can hold. They are written as JSON text and cast, never handed to
// node-pg as objects: node-pg turns a JS array into a Postgres array literal, which is not JSON.
export async function finAudit(qc, { bookId, entity, entityId = null, action, userId = null, userName, reason = null, before = null, after = null }) {
  await qc(
    `INSERT INTO fin_audit_log (book_id, entity, entity_id, action, user_id, user_name, reason, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [bookId, entity, entityId, action, userId, userName, reason, finJson(before), finJson(after)]);
}

// Absent is SQL NULL, not the JSON value null, so "no before" reads the same everywhere.
const finJson = value => (value == null ? null : JSON.stringify(value));
