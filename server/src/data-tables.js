// What a GET response was built from — so the browser can tell, without asking,
// whether that response could have changed.
//
// 75% of all API traffic was a 304: a screen re-asking for data that had not
// changed, and the server running every query of the endpoint to find that out.
// The browser already hears every committed change through the realtime feed
// (ci_erp_realtime_ping, one message per table per transaction). What it lacked
// was the other half: which tables a given response depends on. This module
// supplies it, per request, from the SQL that request actually executed.
//
// Fail-safe in every direction:
//   • a table is recorded when its name appears as a whole word in a statement
//     the request ran — an alias or column that happens to share a table's name
//     only ever ADDS a table, which costs a refetch, never freshness;
//   • any statement that is not a plain read (a write, a lock, a sequence, a
//     transaction, a function with side effects), any failed statement, or any
//     statement we cannot read at all makes the response uncacheable — no header;
//   • a response that read no table at all gets no header either.
// Tables a request WROTE are also reported (X-Data-Wrote), so a GET with a side
// effect — the chat thread stamping last_seen_at — invalidates the caller's own
// cached copies of those tables at once instead of waiting for the broadcast.
//
// The context is captured at CALL time and carried in a closure, never read back
// later: pg-pool hands a queued query to whichever request releases a client, so
// the async context at execution time can belong to a different request.
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';

const als = new AsyncLocalStorage();
let tableRe = null;
let opaqueRe = null;
const memo = new Map();
const MEMO_MAX = 2000;

const wordList = names => [...new Set((names || []).filter(n => /^[a-z_][a-z0-9_]*$/.test(n)))]
  .sort((a, b) => b.length - a.length);

// tables: public base tables. opaque: public views, materialized views and
// functions — each reads tables whose names never appear in the statement, so its
// dependencies cannot be listed and a statement naming one is never cacheable.
export function setKnownTables(names = [], opaque = []) {
  const clean = wordList(names);
  tableRe = clean.length ? new RegExp(`\\b(${clean.join('|')})\\b`, 'gi') : null;
  const hidden = wordList(opaque);
  opaqueRe = hidden.length ? new RegExp(`\\b(${hidden.join('|')})\\b`, 'i') : null;
  memo.clear();
}

// Blank what can mention a table or a keyword without meaning it — comments,
// string literals (standard, E'' with backslash escapes) and dollar-quoted bodies —
// in ONE left-to-right pass, because they hide each other: an apostrophe inside a
// comment is not a string, and "--" inside a string is not a comment. Scanning them
// one kind at a time let "-- don't" swallow the SQL up to the next quote, and with
// it the names of tables the statement really read. Returns null for anything that
// does not lex (an unterminated string or comment): the caller treats it as not a read.
function stripNoise(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  const isIdent = ch => ch != null && /[A-Za-z0-9_$\u0080-\uffff]/.test(ch);
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      out += ' ';
      i = end < 0 ? n : end;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth) return null;
      out += ' ';
    } else if (ch === "'") {
      const escapes = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdent(sql[i - 2]);
      i++;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return null;
      out += "''";
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) return null;
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '$' && !isIdent(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (!m) { out += ch; i++; continue; }
      const close = sql.indexOf(m[0], i + m[0].length);
      if (close < 0) return null;
      out += ' ';
      i = close + m[0].length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Only a statement that STARTS as a read can be one, so these are just the words
// that can turn a SELECT/WITH into something else from the inside: a
// data-modifying CTE, SELECT … INTO, and row locks (FOR UPDATE / FOR SHARE).
const WRITE_WORDS = /\b(insert|update|delete|merge|into|share|truncate|create|alter|drop|grant|revoke|copy|call|notify|lock)\b/i;
const SIDE_EFFECT_FNS = /\b(nextval|setval|set_config|pg_advisory\w*|pg_try_advisory\w*|pg_notify|txid_current|pg_current_xact_id|send|broadcast_changes|http_\w+|net\.\w+|dblink\w*|lo_\w+|pg_sleep\w*|gen_random_uuid|uuid_generate\w*|random|clock_timestamp|timeofday)\s*\(/i;

// Columns whose changes the database deliberately does NOT announce, because they
// change every few seconds without meaning anything to a screen: the presence
// stamp and the chat thread's seen/typing stamps (see the WHEN clauses in the
// realtime migration). A response that reads one of them cannot be proven fresh
// by the feed — "typing…" is literally now() - 6 seconds — so it is never cacheable.
const UNANNOUNCED_COLUMNS = /\b(last_active_at|last_seen_at|typing_at)\b/i;

export function analyseSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return { read: false, tables: [], volatile: true };
  const hit = memo.get(sql);
  if (hit) return hit;
  const body = stripNoise(sql);
  if (body == null) return { read: false, tables: [], volatile: true };
  const startsAsRead = /^\s*\(?\s*(select|with|table|values)\b/i.test(body);
  const read = startsAsRead && !WRITE_WORDS.test(body) && !SIDE_EFFECT_FNS.test(body);
  const volatile = UNANNOUNCED_COLUMNS.test(body) || (opaqueRe != null && opaqueRe.test(body));
  const tables = tableRe ? [...new Set([...body.matchAll(tableRe)].map(m => m[1].toLowerCase()))].sort() : [];
  const out = Object.freeze({ read, tables, volatile });
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(sql, out);
  return out;
}

// The request's ledger. `run` wraps the rest of the middleware chain.
export function newLedger() {
  return { read: new Set(), wrote: new Set(), cacheable: true };
}

// Run fn with `ledger` as the current request's ledger (the middleware's own entry).
export function withLedger(ledger, fn) {
  return als.run(ledger, fn);
}

export function currentLedger() {
  return als.getStore() || null;
}

// Work a request does that is NOT part of its answer — the presence stamp, the
// realtime heartbeat — runs outside the ledger so it can never spoil the response.
export function withoutLedger(fn) {
  return als.exit(fn);
}

// Record one statement into the ledger that was current when it was CALLED.
export function recordStatement(ledger, text) {
  if (!ledger) return;
  const sql = typeof text === 'string' ? text : text?.text;
  const { read, tables, volatile } = analyseSql(sql);
  for (const t of tables) ledger.read.add(t);
  if (volatile) ledger.cacheable = false;
  if (!read) {
    ledger.cacheable = false;
    for (const t of tables) ledger.wrote.add(t);
  }
}

export function markFailed(ledger) {
  if (ledger) ledger.cacheable = false;
}

// Headers for a finished request, or null when there is nothing to say.
export function ledgerHeaders(ledger, { method = 'GET', status = 200 } = {}) {
  if (!ledger) return {};
  const h = {};
  if (method === 'GET' && (status === 200 || status === 304) && ledger.cacheable && ledger.read.size) {
    h['X-Data-Tables'] = [...ledger.read].sort().join(',');
  }
  if (ledger.wrote.size) h['X-Data-Wrote'] = [...ledger.wrote].sort().join(',');
  return h;
}

// Express middleware: one ledger per request, headers stamped on res.end() — the one
// call every way of sending a body makes. NOT on res.send: on Vercel, @vercel/node
// attaches its own res.send/res.json as own properties of the response, and its
// json() writes through an internal send() straight to res.end(), so a res.send hook
// never ran in production (the headers were missing there and present locally).
// A body already streamed (headers sent before end) makes no claim: its headers went
// out before every query had run. A 304 carries the header too, refreshing the
// dependency list the browser keeps with its stored copy.
export function dataTablesMiddleware(req, res, next) {
  const ledger = newLedger();
  const end = res.end;
  res.end = function endWithLedger(...args) {
    if (!this.headersSent) {
      const h = ledgerHeaders(ledger, { method: req.method, status: this.statusCode });
      for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
    }
    return end.apply(this, args);
  };
  als.run(ledger, next);
}

// Wrap a query function (pool.query, or a checked-out client's query) so every
// call records into the ledger current at call time, and a failure spoils it.
export function instrumentQuery(fn, self) {
  return function instrumented(text, ...rest) {
    const ledger = als.getStore() || null;
    recordStatement(ledger, text);
    const cbIndex = rest.findIndex(a => typeof a === 'function');
    if (cbIndex >= 0) {
      const cb = rest[cbIndex];
      // Bound to the CALLER's async context: a reply arrives from the socket's
      // context, and any query issued from inside this callback must still be
      // recorded against the request that asked, or its table goes unlisted.
      rest[cbIndex] = AsyncResource.bind((err, ...args) => { if (err) markFailed(ledger); return cb(err, ...args); });
      return fn.call(self, text, ...rest);
    }
    const result = fn.call(self, text, ...rest);
    if (result && typeof result.then === 'function') result.then(null, () => markFailed(ledger));
    return result;
  };
}

// Wrap pool.query and every client checked out with pool.connect() (tx() uses
// that) so each statement records into the ledger current when it was CALLED.
export function instrumentPool(p) {
  if (p.__ledgerInstrumented) return;
  p.__ledgerInstrumented = true;
  p.query = instrumentQuery(p.query, p);
  const connect = p.connect.bind(p);
  p.connect = (...args) => {
    const wrap = client => {
      if (client && !client.__ledgerInstrumented) {
        client.__ledgerInstrumented = true;
        client.query = instrumentQuery(client.query, client);
      }
      return client;
    };
    if (typeof args[0] === 'function') {
      // pg-pool's own pool.query checks a client out this way, and runs the callback
      // whenever — and from wherever — a client frees up. Bind it to the context
      // that asked, so the statement it issues is recorded against that request.
      const cb = AsyncResource.bind(args[0]);
      return connect((err, client, release) => cb(err, err ? client : wrap(client), release));
    }
    return connect(...args).then(wrap);
  };
}
