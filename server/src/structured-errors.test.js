import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// The error handler in app.js writes:
//   res.status(status).json({ error: err.message, ...(err.body || {}) })
// — `err.body` and NOTHING else. A field hung directly on the error (code, at,
// blockers) is therefore silently dropped before the response is written, and
// the client sees only `error`.
//
// That is not a hypothetical: PLAN_ALREADY_EXECUTED, STAGES_ON_FLOOR and their
// `at` payloads all shipped that way and were only caught by a UAT that asserted
// the response shape rather than the status code. This is a SOURCE guard on
// purpose — the thing being protected IS a source convention, and the runtime
// half is covered by the handler contract asserted below.
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const STRUCTURED = ['code', 'at', 'blockers', 'conflicts', 'existing', 'incoming'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && p.endsWith('.js') && !p.endsWith('.test.js') ? [p] : [];
  });
}

test('a thrown error puts structured data in body, never on the error itself', () => {
  const offenders = [];
  for (const file of walk(HERE)) {
    // Comments are stripped first — this file's own prose, and helpers.js's
    // "Throws {status:409, blockers:[...]} if unsafe", are documentation of the
    // shape, not instances of it. Blank them rather than delete them so the
    // reported line numbers still point at the real source line.
    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
    // The options object handed to Object.assign(new Error(...), { ... }).
    // Matches `status: <n>` followed by keys up to the closing brace.
    const re = /\{\s*status:\s*\d{3}\s*,([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const opts = m[1];
      // A `body: { ... }` nested object is the correct shape — ignore its insides.
      const outside = opts.replace(/body:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
      for (const key of STRUCTURED) {
        if (new RegExp(`(^|[,\\s])${key}\\s*:`).test(outside)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(HERE, file)}:${line} — '${key}' is outside body`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these throws would be silently stripped by the error handler:\n  ${offenders.join('\n  ')}`);
});

// The handler contract the guard above depends on. If app.js ever starts
// spreading the error itself, the guard becomes unnecessary — and this test is
// what will say so, instead of the guard quietly protecting nothing.
test('app.js still spreads err.body and nothing else', () => {
  const app = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8');
  assert.match(app, /\.\.\.\(err\.body \|\| \{\}\)/,
    'error handler no longer spreads err.body — revisit the structured-error convention');
});
