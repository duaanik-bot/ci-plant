# Master File Repository — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Product Master a permanent, versioned file repository — upload, preview, download, replace and archive approved artwork, output files and scans — with bytes stored outside Postgres so files of any realistic size work in production.

**Architecture:** Three-leg upload (sign → browser PUTs straight to storage → commit), so bytes never pass through the Vercel function and the ~4.5 MB body limit stops applying. `files` holds the bytes' metadata; `product_files` holds the versioned slots; a partial unique index makes "one active file per category" a database guarantee. Pure decision logic lives in `file-rules.js` and `master-files.js` so it unit-tests without a database, matching the `chat-rules.js` philosophy already in this repo.

**Tech Stack:** Node 20 ESM, Express 4, Postgres (`pg`), React 18 + Vite + Tailwind, `node:test`. **No new npm dependencies** — the Supabase driver uses global `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-30-master-file-repository-design.md`

**Plan 2** (`record_files`, `<FilePanel>`, the *Update Master?* prompt, pinning, the nine mount points) builds on this and is written separately.

---

## Verification surface — read this before starting

This repo has **no client-side tests**. The entire check is:

```bash
npm test -w server        # node:test over server/src/*.test.js
npm run build -w client   # vite build
npm run verify            # baseline freshness + both of the above
```

So: server logic is TDD'd against real tests. Client tasks are verified by the build **plus a look at the running app** — never claim a UI task works without having loaded it at a desktop breakpoint while signed in.

Two repo rules that will bite if ignored:

- **Editing `init()` does not migrate production.** Schema changes need `npm run db:baseline` and a named migration. See `CLAUDE.md` and `DEPLOYMENT.md` §3.
- **Other Claude sessions edit this same working tree.** Run `git status --short --branch` before staging and stage only your own files.

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/file-rules.js` | **Create.** Categories, size ceilings, mime→preview kind, filename sanitisation, storage-key minting, the prompt predicate. Pure. |
| `server/src/file-rules.test.js` | **Create.** Tests for the above. |
| `server/src/master-files.js` | **Create.** Version-chain decisions: rows in, plan out. Pure. |
| `server/src/master-files.test.js` | **Create.** Tests for the above. |
| `server/src/storage.js` | **Create.** `local` and `supabase` drivers behind one interface. |
| `server/src/storage.test.js` | **Create.** Exercises the `local` driver on a temp dir. |
| `server/src/routes/files.js` | **Create.** Upload lifecycle, download/preview redirects, product repository endpoints, lazy GC. |
| `server/src/db.js` | **Modify.** `files`, `product_files`, `file_downloads`, `users.master_files`. |
| `server/src/auth.js` | **Modify.** Carry `master_files` in the session payload; export `requireMasterFiles`. |
| `server/src/app.js` | **Modify.** Mount the router. |
| `client/src/lib/upload.js` | **Create.** Three-leg upload with progress and conditional checksum. |
| `client/src/components/FileViewer.jsx` | **Create.** Preview modal. |
| `client/src/components/ProductFiles.jsx` | **Create.** The repository editor (five slot cards + history). |
| `client/src/pages/Masters.jsx` | **Modify.** Mount `<ProductFiles>`; add the `master_files` checkbox to Users. |
| `.env.example` | **Modify.** Document the three new variables. |

---

## Task 1: File rules — the pure gate

**Files:**
- Create: `server/src/file-rules.js`
- Test: `server/src/file-rules.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/file-rules.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, CHECKSUM_MAX_BYTES, categoryError, sizeError,
  previewKind, safeName, storageKey, shouldPromptMaster,
} from './file-rules.js';

// ── categories ────────────────────────────────────────────────────────
test('the five real slots are slots; supporting is the open drawer', () => {
  assert.equal(CATEGORIES.approved_artwork.slot, true);
  assert.equal(CATEGORIES.output_file.slot, true);
  assert.equal(CATEGORIES.customer_approved_pdf.slot, true);
  assert.equal(CATEGORIES.shade_card_scan.slot, true);
  assert.equal(CATEGORIES.printing_reference.slot, true);
  assert.equal(CATEGORIES.supporting.slot, false);
});
test('categoryError names the offender without echoing junk back', () => {
  assert.equal(categoryError('approved_artwork'), null);
  assert.match(categoryError('nonsense'), /Unknown file category/);
  assert.match(categoryError('<script>x'), /Unknown file category/);
  assert.doesNotMatch(categoryError('<script>x'), /</);
});
test('categoryError refuses prototype keys', () => {
  assert.match(categoryError('constructor'), /Unknown file category/);
  assert.match(categoryError('__proto__'), /Unknown file category/);
});

// ── size ceilings ─────────────────────────────────────────────────────
test('artwork and output files get 250 MB', () => {
  assert.equal(sizeError('approved_artwork', 200 * 1024 * 1024), null);
  assert.equal(sizeError('output_file', 200 * 1024 * 1024), null);
});
test('proofs and scans get 25 MB', () => {
  assert.equal(sizeError('shade_card_scan', 20 * 1024 * 1024), null);
  assert.match(sizeError('shade_card_scan', 30 * 1024 * 1024), /25 MB/);
});
test('the message names the file its actual size, like 5c17abf taught', () => {
  assert.match(sizeError('printing_reference', 31 * 1024 * 1024), /31 MB/);
});
test('a zero-byte or missing size is refused', () => {
  assert.match(sizeError('approved_artwork', 0), /empty/i);
  assert.match(sizeError('approved_artwork', undefined), /empty/i);
});

// ── preview kind ──────────────────────────────────────────────────────
test('PDF previews inline, images preview, everything else downloads', () => {
  assert.equal(previewKind('application/pdf'), 'pdf');
  assert.equal(previewKind('image/jpeg'), 'image');
  assert.equal(previewKind('image/png'), 'image');
  assert.equal(previewKind('image/svg+xml'), 'image');
  assert.equal(previewKind('application/postscript'), 'none');   // .ai
  assert.equal(previewKind('application/x-coreldraw'), 'none');  // .cdr
  assert.equal(previewKind(undefined), 'none');
});

// ── filename safety ───────────────────────────────────────────────────
test('safeName strips any path the browser sent', () => {
  assert.equal(safeName('C:\\jobs\\carton.pdf'), 'carton.pdf');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a/b/c/art.pdf'), 'art.pdf');
});
test('safeName keeps Hindi and emoji — the 5c17abf mojibake lesson', () => {
  assert.equal(safeName('डिब्बा.pdf'), 'डिब्बा.pdf');
});
test('safeName never returns empty and never returns a dotfile', () => {
  assert.equal(safeName(''), 'file');
  assert.equal(safeName(null), 'file');
  assert.equal(safeName('...'), 'file');
  assert.equal(safeName('/'), 'file');
});
test('safeName drops control characters and caps length', () => {
  assert.equal(safeName('ar\u0000t\u001f.pdf'), 'art.pdf');
  assert.equal(safeName('x'.repeat(300)).length, 120);
});

// ── storage keys ──────────────────────────────────────────────────────
test('a product-scoped key carries product, category and a unique prefix', () => {
  assert.equal(
    storageKey({ productId: 1372, category: 'approved_artwork', uuid: 'abc', file_name: 'art.pdf' }),
    'products/1372/approved_artwork/abc-art.pdf');
});
test('a key with no product is scoped, not rootless', () => {
  assert.equal(
    storageKey({ productId: null, category: 'supporting', uuid: 'abc', file_name: 'note.pdf' }),
    'unscoped/supporting/abc-note.pdf');
});
test('a hostile filename cannot escape its folder', () => {
  const key = storageKey({ productId: 1, category: 'supporting', uuid: 'u', file_name: '../../x.pdf' });
  assert.equal(key, 'products/1/supporting/u-x.pdf');
  assert.doesNotMatch(key, /\.\./);
});

// ── the prompt predicate — spec §6, all four conditions ───────────────
const base = { productId: 1372, category: 'approved_artwork', canMaster: true,
               activeChecksum: 'aaa', checksum: 'bbb' };

test('prompts when all four conditions hold', () => {
  assert.equal(shouldPromptMaster(base), true);
});
test('never prompts for a record with no product', () => {
  assert.equal(shouldPromptMaster({ ...base, productId: null }), false);
});
test('never prompts for the supporting drawer — it has no single slot', () => {
  assert.equal(shouldPromptMaster({ ...base, category: 'supporting' }), false);
});
test('never prompts a user who could not act on it', () => {
  assert.equal(shouldPromptMaster({ ...base, canMaster: false }), false);
});
test('does not prompt when the bytes are already the master', () => {
  assert.equal(shouldPromptMaster({ ...base, checksum: 'aaa', activeChecksum: 'aaa' }), false);
});
test('prompts when the slot is empty', () => {
  assert.equal(shouldPromptMaster({ ...base, activeChecksum: null }), true);
});
test('a big file has no checksum, so it always asks rather than assumes', () => {
  assert.equal(shouldPromptMaster({ ...base, checksum: null }), true);
  assert.equal(shouldPromptMaster({ ...base, checksum: null, activeChecksum: null }), true);
});
test('CHECKSUM_MAX_BYTES is the 25 MB the client checks against', () => {
  assert.equal(CHECKSUM_MAX_BYTES, 25 * 1024 * 1024);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -w server
```
Expected: `Cannot find module './file-rules.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/file-rules.js`:

```js
// ─── Master File Repository rules — pure logic, no DB ────────────────────────
// Everything the file endpoints have to decide without touching Postgres lives
// here so it unit-tests flat: which categories exist, how big a file may be,
// what can be previewed, what a filename may become, and whether the operator
// should be asked to update the master. The route file supplies rows; these
// functions supply verdicts. Same split as chat-rules.js.

const MB = 1024 * 1024;

// Five single-file slots plus one open drawer. `slot: true` is what the partial
// unique index in db.js enforces — exactly one active row per (product,
// category). 'supporting' is deliberately excluded from that index and may hold
// many active documents at once.
export const CATEGORIES = {
  approved_artwork:      { label: 'Approved Artwork',       slot: true,  max: 250 * MB },
  output_file:           { label: 'Output / Imposition',    slot: true,  max: 250 * MB },
  customer_approved_pdf: { label: 'Customer Approved PDF',  slot: true,  max: 25 * MB },
  shade_card_scan:       { label: 'Shade Card Scan',        slot: true,  max: 25 * MB },
  printing_reference:    { label: 'Printing Reference',     slot: true,  max: 25 * MB },
  supporting:            { label: 'Supporting Document',    slot: false, max: 25 * MB },
};
for (const spec of Object.values(CATEGORIES)) Object.freeze(spec);
Object.freeze(CATEGORIES);

// crypto.subtle.digest needs the whole file as one ArrayBuffer. Doing that to a
// 200 MB output file on a plant tablet is a stall the operator reads as a
// crash, so the browser hashes only below this. Above it, checksum stays NULL
// and shouldPromptMaster asks rather than assumes.
export const CHECKSUM_MAX_BYTES = 25 * MB;

// hasOwnProperty, not a bare lookup: CATEGORIES['constructor'] would otherwise
// hand back Object.prototype.constructor and the caller would interpolate a
// function into a storage key. Same guard as record-entities.js entityOr400.
export function isCategory(key) {
  return typeof key === 'string'
    && Object.prototype.hasOwnProperty.call(CATEGORIES, key);
}

export function categoryError(key) {
  if (isCategory(key)) return null;
  // The message lands in a browser, so the echo is sanitized.
  const shown = String(key ?? '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
  return shown ? `Unknown file category '${shown}'` : 'Unknown file category';
}

const mb = n => Math.round(n / MB);

export function sizeError(category, size_bytes) {
  const n = Number(size_bytes);
  if (!Number.isFinite(n) || n <= 0) return 'That file is empty';
  const max = CATEGORIES[category]?.max ?? 25 * MB;
  if (n > max) {
    return `${CATEGORIES[category]?.label ?? 'This file'} is capped at ${mb(max)} MB — `
         + `that one is ${mb(n)} MB`;
  }
  return null;
}

// What the viewer can show without downloading. Everything else is honest
// about it rather than rendering a broken frame. SVG is safe here because the
// viewer renders it in an <img>, which does not execute script.
export function previewKind(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/svg+xml') return 'image';
  return 'none';
}

// The browser sends whatever the OS gave it, including full Windows paths.
// Keep the leaf, keep Unicode (a Hindi filename is a real filename — the
// mojibake half of 5c17abf), drop anything that could steer a storage key.
export function safeName(name) {
  const leaf = String(name ?? '').split(/[/\\]/).pop() ?? '';
  const clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return (clean || 'file').slice(0, 120);
}

// Keys are opaque to everything except this function — that is what lets the
// storage driver be swapped without touching data. `uuid` is passed in rather
// than generated so the key is deterministic under test.
export function storageKey({ productId, category, uuid, file_name }) {
  const scope = productId ? `products/${productId}` : 'unscoped';
  return `${scope}/${category}/${uuid}-${safeName(file_name)}`;
}

// Spec §6: ask to update the master only when all four hold. Deliberately does
// NOT try to infer that one file is "newer" than another — the honest signal is
// that the bytes differ, and a wrong "this is newer" teaches the plant to click
// through the prompt without reading it.
export function shouldPromptMaster({
  productId, category, canMaster, activeChecksum, checksum,
} = {}) {
  if (!productId) return false;
  if (!CATEGORIES[category]?.slot) return false;
  if (!canMaster) return false;
  // Identical bytes are not a new version. Unknown bytes (no checksum, because
  // the file was too big to hash) are treated as different, so we ask.
  if (checksum && activeChecksum && checksum === activeChecksum) return false;
  return true;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w server
```
Expected: all `file-rules` tests pass; nothing else changes.

- [ ] **Step 5: Commit**

```bash
git add server/src/file-rules.js server/src/file-rules.test.js
git commit -m "feat(files): the pure gate for categories, sizes and filenames"
```

---

## Task 2: Version-chain decisions

**Files:**
- Create: `server/src/master-files.js`
- Test: `server/src/master-files.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/master-files.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion, promotionPlan, restorePlan, driftFor } from './master-files.js';

const v = (id, version_no, status, file_id) =>
  ({ id, version_no, status, file_id, category: 'approved_artwork' });

// ── nextVersion ───────────────────────────────────────────────────────
test('an empty slot starts at v1', () => {
  assert.equal(nextVersion([]), 1);
});
test('versions climb from the highest ever used, not the count', () => {
  assert.equal(nextVersion([v(1, 1, 'archived'), v(2, 2, 'archived'), v(3, 3, 'active')]), 4);
});
test('a gap in the chain never reissues a number', () => {
  assert.equal(nextVersion([v(1, 1, 'archived'), v(9, 7, 'active')]), 8);
});

// ── promotionPlan ─────────────────────────────────────────────────────
test('promoting into an empty slot archives nothing', () => {
  const p = promotionPlan({ versions: [], fileId: 50, category: 'approved_artwork' });
  assert.equal(p.archiveId, null);
  assert.equal(p.version_no, 1);
  assert.equal(p.file_id, 50);
});
test('promoting over an active version archives exactly that row', () => {
  const versions = [v(1, 1, 'archived'), v(2, 2, 'active')];
  const p = promotionPlan({ versions, fileId: 50, category: 'approved_artwork', reason: 'customer revised' });
  assert.equal(p.archiveId, 2);
  assert.equal(p.version_no, 3);
  assert.equal(p.replace_reason, 'customer revised');
});
test('the supporting drawer never archives — it holds many at once', () => {
  const versions = [v(1, 1, 'active'), v(2, 2, 'active')].map(r => ({ ...r, category: 'supporting' }));
  const p = promotionPlan({ versions, fileId: 50, category: 'supporting' });
  assert.equal(p.archiveId, null);
  assert.equal(p.version_no, 3);
});
test('a missing reason is null, never an empty string', () => {
  const p = promotionPlan({ versions: [], fileId: 1, category: 'approved_artwork', reason: '  ' });
  assert.equal(p.replace_reason, null);
});

// ── restorePlan — append-only, never a rewind ─────────────────────────
test('restoring re-promotes the old FILE as a NEW version', () => {
  const versions = [v(1, 1, 'archived', 90), v(2, 2, 'active', 91)];
  const p = restorePlan({ versions, archivedId: 1, reason: 'v2 was the wrong die' });
  assert.equal(p.error, undefined);
  assert.equal(p.file_id, 90, 'reuses the archived version’s file');
  assert.equal(p.version_no, 3, 'as a new version — history is append-only');
  assert.equal(p.archiveId, 2, 'and the current active one is archived');
});
test('restoring the already-active version is refused', () => {
  const versions = [v(1, 1, 'archived', 90), v(2, 2, 'active', 91)];
  assert.match(restorePlan({ versions, archivedId: 2 }).error, /already the active/);
});
test('restoring a version from another slot is refused', () => {
  const versions = [v(1, 1, 'active', 90)];
  assert.match(restorePlan({ versions, archivedId: 999 }).error, /does not belong/);
});

// ── driftFor — spec §7, used by Plan 2 but decided here ───────────────
test('no drift when the pin is the active version', () => {
  assert.equal(driftFor({ pinnedVersionNo: 3, activeVersionNo: 3 }), null);
});
test('drift when the master has moved past the pin', () => {
  assert.deepEqual(driftFor({ pinnedVersionNo: 2, activeVersionNo: 3 }),
    { kind: 'moved', master_version: 3 });
});
test('an archived-with-no-replacement slot does not read as drift', () => {
  assert.equal(driftFor({ pinnedVersionNo: 2, activeVersionNo: null }), null);
});
test('a slot filled after the lock is flagged separately, not as drift', () => {
  assert.deepEqual(driftFor({ pinnedVersionNo: null, activeVersionNo: 1 }),
    { kind: 'added_after_lock', master_version: 1 });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -w server
```
Expected: `Cannot find module './master-files.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/master-files.js`:

```js
// ─── Master file version chains — pure decisions, no DB ──────────────────────
// Rows in, plan out. routes/files.js reads the slot's versions, asks for a
// plan, and executes it in one transaction. Keeping the decision here is what
// makes "history is append-only" a tested property rather than a comment.
import { CATEGORIES } from './file-rules.js';

// The highest number ever issued in this slot, plus one. Deliberately not
// `versions.length + 1`: a slot whose history has a gap must never reissue a
// number somebody already read off a job card.
export function nextVersion(versions = []) {
  return versions.reduce((max, v) => Math.max(max, Number(v.version_no) || 0), 0) + 1;
}

const trimmed = s => {
  const t = String(s ?? '').trim();
  return t || null;
};

// What promoting `fileId` into this slot must do. `archiveId` is the row to
// flip to archived and point at the new version; null for an empty slot and
// always null for 'supporting', which holds many active documents at once.
export function promotionPlan({ versions = [], fileId, category, reason = null }) {
  const isSlot = CATEGORIES[category]?.slot === true;
  const active = isSlot ? versions.find(v => v.status === 'active') : null;
  return {
    archiveId: active ? active.id : null,
    category,
    file_id: fileId,
    version_no: nextVersion(versions),
    replace_reason: trimmed(reason),
  };
}

// Restoring never rewinds in place. The archived version's FILE is promoted
// again as a new version, so the chain only ever grows and the job card that
// printed against v2 keeps meaning what it said.
export function restorePlan({ versions = [], archivedId, reason = null }) {
  const src = versions.find(v => +v.id === +archivedId);
  if (!src) return { error: 'That version does not belong to this slot' };
  if (src.status === 'active') return { error: 'That version is already the active one' };
  return promotionPlan({ versions, fileId: src.file_id, category: src.category, reason });
}

// Spec §7 — how a pinned record differs from the master today. One rule:
// show the pin, and show how the master differs from it.
export function driftFor({ pinnedVersionNo, activeVersionNo }) {
  const pinned = pinnedVersionNo ?? null;
  const active = activeVersionNo ?? null;
  if (active == null) return null;                       // nothing active to differ from
  if (pinned == null) return { kind: 'added_after_lock', master_version: active };
  if (active > pinned) return { kind: 'moved', master_version: active };
  return null;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w server
```
Expected: `master-files` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/master-files.js server/src/master-files.test.js
git commit -m "feat(files): version chains are append-only, and that is now tested"
```

---

## Task 3: The storage layer

**Files:**
- Create: `server/src/storage.js`
- Test: `server/src/storage.test.js`

The `supabase` driver is written here but only exercised in Task 11. Tests never touch the network.

- [ ] **Step 1: Write the failing test**

Create `server/src/storage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalDriver } from './storage.js';

async function tmpDriver() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cifiles-'));
  return { driver: createLocalDriver({ root, baseUrl: 'http://localhost:4000' }), root };
}

test('a written object reports its real size', async () => {
  const { driver } = await tmpDriver();
  await driver.write('products/1/approved_artwork/u-a.pdf', Buffer.from('hello'));
  assert.deepEqual(await driver.head('products/1/approved_artwork/u-a.pdf'),
    { exists: true, size: 5 });
});

test('head on a missing object is a verdict, not a throw', async () => {
  const { driver } = await tmpDriver();
  assert.deepEqual(await driver.head('nope/missing.pdf'), { exists: false, size: 0 });
});

test('read returns exactly what was written', async () => {
  const { driver } = await tmpDriver();
  await driver.write('a/b/c.bin', Buffer.from([1, 2, 3]));
  assert.deepEqual([...await driver.read('a/b/c.bin')], [1, 2, 3]);
});

test('remove is idempotent — GC must never crash on an already-gone object', async () => {
  const { driver } = await tmpDriver();
  await driver.write('a/b.pdf', Buffer.from('x'));
  await driver.remove('a/b.pdf');
  await driver.remove('a/b.pdf');
  assert.equal((await driver.head('a/b.pdf')).exists, false);
});

test('a key cannot escape the storage root', async () => {
  const { driver, root } = await tmpDriver();
  await assert.rejects(() => driver.write('../escaped.pdf', Buffer.from('x')), /Invalid storage key/);
  await assert.rejects(() => driver.head('../../etc/passwd'), /Invalid storage key/);
  assert.equal((await fs.readdir(path.dirname(root))).includes('escaped.pdf'), false);
});

test('an absolute key is refused too', async () => {
  const { driver } = await tmpDriver();
  await assert.rejects(() => driver.write('/etc/passwd', Buffer.from('x')), /Invalid storage key/);
});

test('putUrl points the browser at our own route in local mode', async () => {
  const { driver } = await tmpDriver();
  const put = await driver.putUrl('a/b.pdf');
  assert.equal(put.method, 'PUT');
  assert.match(put.url, /^http:\/\/localhost:4000\/api\/files\/local\//);
});

test('getUrl round-trips a key with spaces and unicode', async () => {
  const { driver } = await tmpDriver();
  const url = await driver.getUrl('products/1/supporting/u-डिब्बा copy.pdf');
  assert.equal(decodeURIComponent(new URL(url).pathname.split('/api/files/local/')[1]),
    'products/1/supporting/u-डिब्बा copy.pdf');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -w server
```
Expected: `Cannot find module './storage.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/storage.js`:

```js
// ─── File storage — one interface, two drivers ───────────────────────────────
// The property this whole feature rests on: BYTES NEVER PASS THROUGH THE VERCEL
// FUNCTION. Production refuses a request body past ~4.5 MB before Express sees
// it (commit 5c17abf), so an approved artwork PDF or a 200 MB output file could
// never be uploaded the ordinary way. Instead the browser is handed a signed URL
// and talks to the bucket directly; downloads are a 302 to a signed URL.
//
//   local     — server/.filestore, URLs point at our own Express routes. `npm
//               run dev` uses this and needs no .env, matching the repo's
//               "local development needs no configuration" property.
//   supabase  — Storage REST over global fetch. No new npm dependency.
import fs from 'node:fs/promises';
import path from 'node:path';

// Upload URLs outlive download URLs on purpose: 90 MB over plant wifi can take
// a while, whereas a download URL is handed to a browser and should not stay
// forwardable.
export const UPLOAD_TTL_SECS = 2 * 60 * 60;
export const DOWNLOAD_TTL_SECS = 5 * 60;

// A key is built by file-rules.storageKey and is opaque everywhere else. This
// is the belt to that braces: nothing that could climb out of the root is ever
// turned into a path.
function assertKey(key) {
  const k = String(key ?? '');
  if (!k || k.startsWith('/') || k.includes('..') || k.includes('\0')) {
    throw Object.assign(new Error('Invalid storage key'), { status: 400 });
  }
  return k;
}

export function createLocalDriver({ root, baseUrl }) {
  const full = key => path.join(root, assertKey(key));
  return {
    name: 'local',
    async putUrl(key) {
      return {
        url: `${baseUrl}/api/files/local/${encodeURIComponent(assertKey(key))}`,
        method: 'PUT',
        headers: {},
      };
    },
    async getUrl(key) {
      return `${baseUrl}/api/files/local/${encodeURIComponent(assertKey(key))}`;
    },
    async head(key) {
      try {
        const st = await fs.stat(full(key));
        return { exists: true, size: st.size };
      } catch (e) {
        if (e.status) throw e;              // an invalid key is a real error
        return { exists: false, size: 0 };  // a missing file is a verdict
      }
    },
    async write(key, buffer) {
      const p = full(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, buffer);
    },
    async read(key) {
      return fs.readFile(full(key));
    },
    async remove(key) {
      // GC calls this on objects that may already be gone. Never throw for that.
      await fs.rm(full(key), { force: true });
    },
  };
}

// Supabase Storage REST. Signed upload: ask for a token, then the browser PUTs
// to the same path with ?token=. Signed download: ask for a relative signed URL
// and absolutise it. Both are plain fetch — deliberately no @supabase/supabase-js,
// which would be a new dependency for two endpoints.
export function createSupabaseDriver({ url, serviceKey, bucket }) {
  const base = url.replace(/\/+$/, '');
  const admin = (p, init = {}) => fetch(`${base}/storage/v1${p}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const enc = key => assertKey(key).split('/').map(encodeURIComponent).join('/');

  async function json(res, what) {
    if (!res.ok) {
      throw Object.assign(new Error(`File storage is unavailable (${what}: ${res.status})`),
        { status: 503 });
    }
    return res.json();
  }

  return {
    name: 'supabase',
    async putUrl(key) {
      const body = await json(
        await admin(`/object/upload/sign/${bucket}/${enc(key)}`, {
          method: 'POST',
          body: JSON.stringify({ expiresIn: UPLOAD_TTL_SECS }),
        }), 'sign upload');
      // body.url is relative, e.g. '/object/upload/sign/<bucket>/<key>?token=…'
      return { url: `${base}/storage/v1${body.url}`, method: 'PUT', headers: {} };
    },
    async getUrl(key, { inline = false, download } = {}) {
      const body = await json(
        await admin(`/object/sign/${bucket}/${enc(key)}`, {
          method: 'POST',
          body: JSON.stringify({ expiresIn: DOWNLOAD_TTL_SECS }),
        }), 'sign download');
      const u = new URL(`${base}/storage/v1${body.signedURL ?? body.signedUrl}`);
      // Supabase honours ?download=<name> as Content-Disposition: attachment.
      if (!inline) u.searchParams.set('download', download || 'file');
      return u.toString();
    },
    async head(key) {
      const res = await admin(`/object/info/${bucket}/${enc(key)}`, { method: 'GET' });
      if (res.status === 404) return { exists: false, size: 0 };
      const body = await json(res, 'head');
      return { exists: true, size: Number(body.size ?? body.contentLength ?? 0) };
    },
    async remove(key) {
      const res = await admin(`/object/${bucket}/${enc(key)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw Object.assign(new Error('File storage is unavailable (remove)'), { status: 503 });
      }
    },
  };
}

let cached = null;

// Chosen by FILE_STORAGE, defaulting to local whenever DATABASE_URL is unset —
// so `npm run dev` still needs no .env at all.
export function storage() {
  if (cached) return cached;
  const mode = process.env.FILE_STORAGE
    || (process.env.DATABASE_URL ? 'supabase' : 'local');
  if (mode === 'supabase') {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error(
        'FILE_STORAGE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    cached = createSupabaseDriver({
      url, serviceKey, bucket: process.env.SUPABASE_BUCKET || 'ci-files',
    });
  } else {
    cached = createLocalDriver({
      root: new URL('../.filestore/', import.meta.url).pathname,
      baseUrl: process.env.LOCAL_FILE_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,
    });
  }
  return cached;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w server
```
Expected: all `storage` tests pass.

- [ ] **Step 5: Keep the local store out of git**

Append to `.gitignore`:

```
server/.filestore/
```

- [ ] **Step 6: Commit**

```bash
git add server/src/storage.js server/src/storage.test.js .gitignore
git commit -m "feat(files): storage drivers, so bytes never cross the Vercel function"
```

---

## Task 4: Schema

**Files:**
- Modify: `server/src/db.js` (append to the migrations section, at the end of `init()`)

- [ ] **Step 1: Add the schema**

Append this block at the **end** of `init()` in `server/src/db.js`, after every existing statement. Ordering matters: `CLAUDE.md` requires every statement be idempotent and ordered after the table it touches.

```js
  // ── Master File Repository (2026-07-30) ────────────────────────────────────
  // Files that belong to a PRODUCT rather than to a moment: approved artwork,
  // the output/imposition file, the customer-approved PDF. Promoted once and
  // then carried by every record for that product, so nobody re-uploads and no
  // department works from a superseded version.
  //
  // The bytes are NOT here. They live in object storage (server/.filestore
  // locally, a private Supabase bucket in production) because production runs
  // as a Vercel function that refuses request bodies past ~4.5 MB — see commit
  // 5c17abf. An output file is routinely 200 MB.
  await pool.query(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  uploaded_by TEXT,
  uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_pending ON files (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS product_files (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN
    ('approved_artwork','output_file','customer_approved_pdf',
     'shade_card_scan','printing_reference','supporting')),
  version_no INTEGER NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  replace_reason TEXT,
  superseded_by INTEGER REFERENCES product_files(id),
  promoted_from_entity TEXT,
  promoted_from_id INTEGER,
  created_by TEXT,
  created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by TEXT
);

-- THE single-source-of-truth rule, enforced by Postgres rather than by hopeful
-- code: exactly one active file per (product, category). 'supporting' is the
-- open drawer and is deliberately excluded — it may hold many at once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_files_active
  ON product_files (product_id, category)
  WHERE status = 'active' AND category <> 'supporting';

CREATE INDEX IF NOT EXISTS idx_product_files_product
  ON product_files (product_id, category, version_no DESC);

-- Download history. Deliberately NOT audit_log: every operator opening the
-- artwork on every job would flood the plant's global History drawer into
-- uselessness. Surfaced only in the file's own history.
CREATE TABLE IF NOT EXISTS file_downloads (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  entity TEXT, entity_id INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_downloads_file ON file_downloads (file_id, at DESC);

-- Who may overwrite an official approved document. A per-user flag, NOT a role,
-- for exactly the reason xs_approver gives above: several plant logins carry
-- role='admin', and a role check would hand this back to all of them. There is
-- deliberately no admin bypass anywhere in routes/files.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS master_files INTEGER NOT NULL DEFAULT 0;
UPDATE users SET master_files = 1
WHERE email IN ('md@motionci.com', 'plant@motionci.com')
  AND NOT EXISTS (SELECT 1 FROM users WHERE master_files = 1);
`);
```

- [ ] **Step 2: Rebuild the baseline and prove it replays into an empty DB**

```bash
npm run db:baseline
npm run db:check -- --baseline
```
Expected: baseline regenerates and replays cleanly. A failure here means a statement is out of order — fix the ordering, do not reorder the tables.

- [ ] **Step 3: Run the full verification**

```bash
npm run verify
```
Expected: baseline fresh, server tests pass, client builds. `record-entities.test.js` still passes — nothing it asserts moved.

- [ ] **Step 4: Commit**

```bash
git status --short --branch    # other sessions share this tree — stage only these
git add server/src/db.js supabase/migrations/0001_baseline_schema.sql
git commit -m "feat(files): schema for the master file repository"
```

---

## Task 5: Permission flag in the session

**Files:**
- Modify: `server/src/auth.js`

- [ ] **Step 1: Carry the flag in the session payload**

In `server/src/auth.js`, add `master_files` to the three places `xs_approver` already appears — the session `SELECT` (~line 53), the returned user object (~line 72), and the `usersRouter` `SELECT`/`INSERT`/`UPDATE`/`RETURNING` lists (~lines 156–214).

Session select:

```js
'SELECT id, name, email, role, active, modules, sections, machine_ids, landing_path, xs_approver, is_management, master_files FROM users WHERE id=$1',
```

Returned user object, beside the other flags:

```js
    master_files: +(u.master_files ?? 0),
```

In `usersRouter`, add `master_files` to the list `SELECT`, to the `INSERT` column list and `RETURNING`, and to the `PUT` field handling beside `xs_approver`:

```js
    if ('master_files' in req.body) { sets.push(`master_files=$${i++}`); vals.push(cleanFlag(req.body.master_files)); }
```

- [ ] **Step 2: Export the gate**

Add to `server/src/auth.js`, next to `requireRole`:

```js
// Master files may be promoted, replaced, archived and restored ONLY by a
// holder of this flag. There is no admin bypass, and that is deliberate:
// several plant logins carry role='admin', so a role check would hand the
// power to overwrite approved artwork back to all of them. Same reasoning the
// xs_approver flag already records in db.js.
export function requireMasterFiles(req, res, next) {
  if (+req.user?.master_files === 1) return next();
  res.status(403).json({
    error: 'Only users with Master Files permission can change official product files',
  });
}
```

- [ ] **Step 3: Verify nothing regressed**

```bash
npm test -w server
```
Expected: green. `approvals.test.js` still passes — the flag is additive.

- [ ] **Step 4: Commit**

```bash
git add server/src/auth.js
git commit -m "feat(files): master_files permission flag, with no admin bypass"
```

---

## Task 6: Upload lifecycle endpoints

**Files:**
- Create: `server/src/routes/files.js`
- Modify: `server/src/app.js`

- [ ] **Step 1: Write the router**

Create `server/src/routes/files.js`:

```js
// ─── Files — upload lifecycle and the product master repository ──────────────
// Upload is three legs and the middle one does not touch this server:
//   1. POST /files/sign      permission + validation, mint a key, pending row
//   2. browser PUTs the bytes STRAIGHT TO THE BUCKET
//   3. POST /files/:id/commit  verify the object landed, flip to ready
// Downloads are a 302 to a short-lived signed URL. Nothing here ever buffers a
// file, which is the only reason a 200 MB output file works in production.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { q, one, tx } from '../db.js';
import { requireMasterFiles } from '../auth.js';
import { storage } from '../storage.js';
import {
  CATEGORIES, categoryError, sizeError, safeName, storageKey, previewKind,
} from '../file-rules.js';
import { promotionPlan, restorePlan } from '../master-files.js';

const r = express.Router();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ── Lazy GC ─────────────────────────────────────────────────────────────────
// vercel.json defines no cron jobs and this feature does not add one. Instead
// every sign call sweeps a bounded handful of rows nothing points at: uploads
// that never landed, and commits whose prompt was never answered. Bounded work
// on a request that is already doing storage I/O, and it only runs when uploads
// are happening — which is exactly when abandoned rows appear.
const GC_BATCH = 20;
const GC_AGE = "24 hours";

async function sweep() {
  const dead = await q(`
    SELECT f.id, f.storage_key FROM files f
    WHERE f.created_at < now() - INTERVAL '${GC_AGE}'
      AND (f.status = 'pending'
           OR NOT EXISTS (SELECT 1 FROM product_files pf WHERE pf.file_id = f.id))
    ORDER BY f.created_at LIMIT ${GC_BATCH}`);
  for (const f of dead) {
    try { await storage().remove(f.storage_key); } catch { /* object already gone */ }
    await q('DELETE FROM files WHERE id=$1', [f.id]);
  }
}

// ── 1. Sign ─────────────────────────────────────────────────────────────────
r.post('/files/sign', async (req, res, next) => {
  try {
    const { product_id = null, category, file_name, mime, size_bytes, checksum = null } = req.body ?? {};

    const catErr = categoryError(category);
    if (catErr) throw bad(catErr);
    const sizeErr = sizeError(category, size_bytes);
    if (sizeErr) throw bad(sizeErr);
    if (!mime) throw bad('That file has no type the browser could report');

    if (product_id != null) {
      const p = await one('SELECT id FROM products WHERE id=$1', [product_id]);
      if (!p) throw bad('That product no longer exists', 404);
    }

    sweep().catch(() => {});   // never let GC fail an upload

    const key = storageKey({
      productId: product_id, category, uuid: randomUUID(), file_name,
    });
    const file = await one(`
      INSERT INTO files (storage_key, file_name, mime, size_bytes, checksum,
                         uploaded_by, uploaded_by_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, storage_key, file_name, mime, size_bytes, status`,
      [key, safeName(file_name), mime, Number(size_bytes), checksum,
       req.user.name, req.user.id]);

    res.json({ file_id: file.id, upload: await storage().putUrl(key) });
  } catch (e) { next(e); }
});

// ── 2. (the browser PUTs the bytes; in local mode, to the route below) ──────
// Local driver only. In production the browser talks to Supabase directly and
// this route is never called. express.raw is scoped to THIS route so the 4 MB
// json body parser in app.js is untouched.
r.put('/files/local/:key(*)',
  express.raw({ type: '*/*', limit: '300mb' }),
  async (req, res, next) => {
    try {
      if (storage().name !== 'local') throw bad('Not available', 404);
      await storage().write(decodeURIComponent(req.params.key), req.body);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

r.get('/files/local/:key(*)', async (req, res, next) => {
  try {
    if (storage().name !== 'local') throw bad('Not available', 404);
    const key = decodeURIComponent(req.params.key);
    const f = await one('SELECT file_name, mime FROM files WHERE storage_key=$1', [key]);
    res.setHeader('Content-Type', f?.mime || 'application/octet-stream');
    if (req.query.inline !== '1') {
      res.setHeader('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(f?.file_name || 'file')}`);
    }
    res.send(await storage().read(key));
  } catch (e) { next(e); }
});

// ── 3. Commit ───────────────────────────────────────────────────────────────
// The object is only real once we have SEEN it. A commit that cannot find its
// object deletes the row rather than leaving a phantom pointing at nothing.
r.post('/files/:id(\\d+)/commit', async (req, res, next) => {
  try {
    const file = await one('SELECT * FROM files WHERE id=$1', [req.params.id]);
    if (!file) throw bad('That upload is no longer available', 404);
    if (file.status === 'ready') return res.json({ file });

    const info = await storage().head(file.storage_key);
    if (!info.exists) {
      await q('DELETE FROM files WHERE id=$1', [file.id]);
      throw bad('The upload did not finish — pick the file and try again');
    }
    if (Number(info.size) !== Number(file.size_bytes)) {
      await storage().remove(file.storage_key).catch(() => {});
      await q('DELETE FROM files WHERE id=$1', [file.id]);
      throw bad('The uploaded file did not match what was declared — try again');
    }

    const ready = await one(
      `UPDATE files SET status='ready' WHERE id=$1
       RETURNING id, file_name, mime, size_bytes, checksum, status, uploaded_by, created_at`,
      [file.id]);
    res.json({ file: ready });
  } catch (e) { next(e); }
});

// Discard an uncommitted or unresolved upload — the modal's Cancel.
r.delete('/files/:id(\\d+)', async (req, res, next) => {
  try {
    const file = await one('SELECT * FROM files WHERE id=$1', [req.params.id]);
    if (!file) return res.json({ ok: true });
    const used = await one('SELECT 1 FROM product_files WHERE file_id=$1 LIMIT 1', [file.id]);
    if (used) throw bad('That file is part of the Product Master and cannot be discarded', 409);
    await storage().remove(file.storage_key).catch(() => {});
    await q('DELETE FROM files WHERE id=$1', [file.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Download / preview — always a redirect, never a proxy ───────────────────
async function redirectTo(req, res, inline) {
  const file = await one(
    `SELECT id, storage_key, file_name, mime, status FROM files WHERE id=$1`, [req.params.id]);
  if (!file || file.status !== 'ready') throw bad('That file is not available', 404);
  if (!inline) {
    await q(`INSERT INTO file_downloads (file_id, user_id, user_name, entity, entity_id)
             VALUES ($1,$2,$3,$4,$5)`,
      [file.id, req.user.id, req.user.name,
       req.query.entity ?? null, req.query.entity_id ?? null]);
  }
  res.redirect(302, await storage().getUrl(file.storage_key, {
    inline, download: file.file_name,
  }));
}

r.get('/files/:id(\\d+)/download', (req, res, next) =>
  redirectTo(req, res, false).catch(next));

r.get('/files/:id(\\d+)/preview', (req, res, next) => {
  if (previewKind(req.query.mime) === 'none' && req.query.mime) {
    return next(bad('That file type cannot be previewed'));
  }
  return redirectTo(req, res, true).catch(next);
});

r.get('/files/:id(\\d+)/downloads', async (req, res, next) => {
  try {
    res.json(await q(
      `SELECT user_name, entity, entity_id, at FROM file_downloads
       WHERE file_id=$1 ORDER BY at DESC LIMIT 100`, [req.params.id]));
  } catch (e) { next(e); }
});

export default r;
```

- [ ] **Step 2: Mount it**

In `server/src/app.js`, add the import beside the others and mount it after `chat`:

```js
import files from './routes/files.js';
```
```js
app.use('/api', files);
```

- [ ] **Step 3: Verify the server still boots and tests pass**

```bash
npm test -w server
npm run dev -w server
```
Expected: tests green; the server starts on :4000 with no error. Stop it once confirmed.

- [ ] **Step 4: Prove the round-trip by hand**

With the dev server running and a token in `$T` (log in via the UI and copy it from `localStorage`):

```bash
curl -sS -X POST localhost:4000/api/files/sign -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"product_id":1,"category":"approved_artwork","file_name":"a.pdf","mime":"application/pdf","size_bytes":5}'
```
Expected: `{"file_id":1,"upload":{"url":"http://localhost:4000/api/files/local/...","method":"PUT","headers":{}}}`

```bash
curl -sS -X PUT "<that url>" --data-binary 'hello'
curl -sS -X POST localhost:4000/api/files/1/commit -H "authorization: Bearer $T"
```
Expected: the commit returns `"status":"ready"`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/files.js server/src/app.js
git commit -m "feat(files): three-leg upload, signed downloads, lazy GC"
```

---

## Task 7: Product repository endpoints

**Files:**
- Modify: `server/src/routes/files.js`

- [ ] **Step 1: Add the repository endpoints**

Append to `server/src/routes/files.js`, before `export default r;`:

```js
// ── The Product Master repository ────────────────────────────────────────────
// Reads are open to every signed-in user. Every WRITE is gated on
// requireMasterFiles — no admin bypass, deliberately.

const SLOT_SELECT = `
  SELECT pf.id, pf.category, pf.version_no, pf.status, pf.effective_from,
         pf.replace_reason, pf.superseded_by, pf.promoted_from_entity,
         pf.promoted_from_id, pf.created_by, pf.created_at,
         pf.archived_at, pf.archived_by,
         f.id AS file_id, f.file_name, f.mime, f.size_bytes, f.checksum
  FROM product_files pf JOIN files f ON f.id = pf.file_id
  WHERE pf.product_id = $1
  ORDER BY pf.category, pf.version_no DESC`;

r.get('/products/:id(\\d+)/files', async (req, res, next) => {
  try {
    const rows = await q(SLOT_SELECT, [req.params.id]);
    const slots = Object.entries(CATEGORIES).map(([key, meta]) => ({
      category: key,
      label: meta.label,
      slot: meta.slot,
      max_bytes: meta.max,
      active: rows.filter(v => v.category === key && v.status === 'active'),
      history: rows.filter(v => v.category === key && v.status === 'archived'),
    }));
    res.json({ slots });
  } catch (e) { next(e); }
});

// Promote a READY file into a slot. The plan comes from master-files.js so the
// append-only rule is a tested property; this function only executes it.
async function promote({ productId, fileId, category, reason, user, from }) {
  return tx(async ({ q: qc, one: oc }) => {
    const file = await oc(`SELECT id, status FROM files WHERE id=$1`, [fileId]);
    if (!file) throw bad('That file is no longer available', 404);
    if (file.status !== 'ready') throw bad('That upload has not finished yet');

    const versions = await qc(
      `SELECT id, version_no, status, file_id, category FROM product_files
       WHERE product_id=$1 AND category=$2 FOR UPDATE`, [productId, category]);

    const plan = promotionPlan({ versions, fileId, category, reason });

    const created = await oc(`
      INSERT INTO product_files
        (product_id, category, version_no, file_id, replace_reason,
         promoted_from_entity, promoted_from_id, created_by, created_by_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [productId, category, plan.version_no, plan.file_id, plan.replace_reason,
       from?.entity ?? null, from?.entity_id ?? null, user.name, user.id]);

    if (plan.archiveId) {
      await qc(`UPDATE product_files
                SET status='archived', archived_at=now(), archived_by=$2, superseded_by=$3
                WHERE id=$1`, [plan.archiveId, user.name, created.id]);
    }

    await qc(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
              VALUES ('product',$1,$2,$3,$4)`,
      [productId,
       plan.archiveId ? 'file_replaced' : 'file_promoted',
       `${CATEGORIES[category].label} v${plan.version_no}`
         + (plan.replace_reason ? ` — ${plan.replace_reason}` : '')
         + (from?.entity ? ` (from ${from.entity})` : ''),
       user.name]);

    return created;
  });
}

r.post('/products/:id(\\d+)/files/promote', requireMasterFiles, async (req, res, next) => {
  try {
    const { file_id, category, reason = null, from = null } = req.body ?? {};
    const catErr = categoryError(category);
    if (catErr) throw bad(catErr);
    res.json({ product_file: await promote({
      productId: +req.params.id, fileId: file_id, category, reason, user: req.user, from,
    }) });
  } catch (e) {
    // Two people promoting the same slot at once: the partial unique index
    // fails the loser's INSERT. Answer with the structured 409 this codebase
    // already uses rather than a 500 nobody can act on.
    if (e.code === '23505') {
      return res.status(409).json({
        error: 'Someone else just updated this file in the Product Master. '
             + 'Reload to see their version, then decide whether yours replaces it.',
      });
    }
    next(e);
  }
});

r.post('/product-files/:id(\\d+)/archive', requireMasterFiles, async (req, res, next) => {
  try {
    const pf = await one('SELECT * FROM product_files WHERE id=$1', [req.params.id]);
    if (!pf) throw bad('That version no longer exists', 404);
    if (pf.status !== 'active') throw bad('That version is already archived');
    await q(`UPDATE product_files SET status='archived', archived_at=now(), archived_by=$2
             WHERE id=$1`, [pf.id, req.user.name]);
    await q(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
             VALUES ('product',$1,'file_archived',$2,$3)`,
      [pf.product_id, `${CATEGORIES[pf.category].label} v${pf.version_no}`, req.user.name]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Restore never rewinds in place — it re-promotes the archived version's FILE
// as a NEW version, so a job card that printed against v2 keeps meaning it.
r.post('/product-files/:id(\\d+)/restore', requireMasterFiles, async (req, res, next) => {
  try {
    const pf = await one('SELECT * FROM product_files WHERE id=$1', [req.params.id]);
    if (!pf) throw bad('That version no longer exists', 404);
    const versions = await q(
      `SELECT id, version_no, status, file_id, category FROM product_files
       WHERE product_id=$1 AND category=$2`, [pf.product_id, pf.category]);
    const plan = restorePlan({ versions, archivedId: pf.id, reason: req.body?.reason });
    if (plan.error) throw bad(plan.error);
    const created = await promote({
      productId: pf.product_id, fileId: plan.file_id, category: pf.category,
      reason: plan.replace_reason, user: req.user, from: null,
    });
    res.json({ product_file: created });
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Confirm `tx` exports what this uses**

```bash
grep -n "export async function tx\|export function tx" server/src/db.js
```
Expected: `tx` exists. If its callback signature differs from `({ q, one })`, adapt the two `tx` call sites above to match — **do not change `db.js`**. Check an existing caller for the real shape:

```bash
grep -n "await tx(" server/src/routes/dispatch.js | head -3
```

- [ ] **Step 3: Verify**

```bash
npm test -w server && npm run build -w client
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/files.js
git commit -m "feat(files): promote, archive and restore master file versions"
```

---

## Task 8: Client upload helper

**Files:**
- Create: `client/src/lib/upload.js`

- [ ] **Step 1: Write it**

Create `client/src/lib/upload.js`:

```js
// ─── Three-leg upload ────────────────────────────────────────────────────────
// sign → PUT straight to storage → commit. The middle leg never touches our
// API server, which is the only reason a 200 MB output file uploads at all:
// production is a Vercel function that refuses bodies past ~4.5 MB.
import { api, auth } from '../api.js';

const MB = 1024 * 1024;
export const CHECKSUM_MAX_BYTES = 25 * MB;

// Mirrors CATEGORIES in server/src/file-rules.js. Checked HERE as well as on
// the server so the operator is told before the bytes leave the machine and is
// given the file's actual size — the lesson of commit 5c17abf.
export const CATEGORY_MAX = {
  approved_artwork: 250 * MB,
  output_file: 250 * MB,
  customer_approved_pdf: 25 * MB,
  shade_card_scan: 25 * MB,
  printing_reference: 25 * MB,
  supporting: 25 * MB,
};

export const CATEGORY_LABEL = {
  approved_artwork: 'Approved Artwork',
  output_file: 'Output / Imposition',
  customer_approved_pdf: 'Customer Approved PDF',
  shade_card_scan: 'Shade Card Scan',
  printing_reference: 'Printing Reference',
  supporting: 'Supporting Document',
};

const mb = n => Math.round(n / MB);

export function pickError(category, file) {
  if (!file) return 'Pick a file first';
  if (!file.size) return 'That file is empty';
  const max = CATEGORY_MAX[category] ?? 25 * MB;
  if (file.size > max) {
    return `${CATEGORY_LABEL[category] ?? 'This file'} is capped at ${mb(max)} MB — `
         + `that one is ${mb(file.size)} MB`;
  }
  return null;
}

// crypto.subtle needs the whole file in memory. Above 25 MB that is a stall the
// operator reads as a crash, so we skip it and the server asks rather than
// assumes. Also unavailable on plain-http origins, hence the guard.
async function checksum(file) {
  if (file.size > CHECKSUM_MAX_BYTES || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// XHR rather than fetch: fetch cannot report upload progress, and a plant on
// wifi pushing 90 MB needs to see something moving.
function put(url, method, headers, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    if (!headers?.['content-type']) xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve()
      : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed — check the connection and try again'));
    xhr.send(file);
  });
}

// Returns { file, prompt } — `prompt` is populated by Plan 2 and is null here.
export async function uploadFile({ file, category, productId = null, onProgress }) {
  const err = pickError(category, file);
  if (err) throw new Error(err);

  onProgress?.(0);
  const signed = await api.post('/files/sign', {
    product_id: productId,
    category,
    file_name: file.name,
    mime: file.type || 'application/octet-stream',
    size_bytes: file.size,
    checksum: await checksum(file),
  });

  // Local dev PUTs to our own route, which needs the bearer token; a signed
  // bucket URL must NOT carry it.
  const local = signed.upload.url.includes('/api/files/local/');
  const headers = local ? { authorization: `Bearer ${auth.token()}` } : signed.upload.headers;

  await put(signed.upload.url, signed.upload.method, headers, file, onProgress);
  onProgress?.(1);

  return api.post(`/files/${signed.file_id}/commit`, {});
}
```

- [ ] **Step 2: Match the real `api` and `auth` helpers**

`api.post` and `auth.token()` are assumed above. Confirm the real names:

```bash
grep -n "export const api\|export const auth\|post:\|token" client/src/api.js | head -20
```
Adapt the three call sites in `upload.js` to whatever `client/src/api.js` actually exports. **Do not add new helpers to `api.js`** unless one is genuinely missing.

- [ ] **Step 3: Verify the build**

```bash
npm run build -w client
```
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/upload.js
git commit -m "feat(files): three-leg upload helper with progress"
```

---

## Task 9: The file viewer

**Files:**
- Create: `client/src/components/FileViewer.jsx`

- [ ] **Step 1: Write it**

Create `client/src/components/FileViewer.jsx`:

```jsx
// ─── File viewer ─────────────────────────────────────────────────────────────
// PDFs render in an iframe (browsers do this natively — pulling pdf.js into the
// client bundle would cost ~1 MB for nothing). Images render in an <img>, which
// is also why an SVG is safe here: <img> does not execute script inside one.
// Everything else is honest about not being previewable rather than showing a
// broken frame.
import { useEffect, useState } from 'react';
import { X, Download, ExternalLink, Printer, FileQuestion } from 'lucide-react';
import { Modal, Button } from './ui.jsx';
import { api } from '../api.js';

export function previewKind(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/svg+xml') return 'image';
  return 'none';
}

const mb = n => (n / (1024 * 1024)).toFixed(n < 1024 * 1024 ? 2 : 1);

export default function FileViewer({ file, open, onClose }) {
  const [url, setUrl] = useState(null);
  const kind = previewKind(file?.mime);

  // The signed URL is minted per open and expires in 5 minutes, so it is
  // fetched on open rather than held in a list.
  useEffect(() => {
    if (!open || !file || kind === 'none') { setUrl(null); return; }
    setUrl(api.url(`/files/${file.file_id ?? file.id}/preview`));
  }, [open, file, kind]);

  if (!file) return null;
  const dl = api.url(`/files/${file.file_id ?? file.id}/download`);

  return (
    <Modal open={open} onClose={onClose} title={file.file_name} wide>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#1D1D1F]/60">
          <span>{file.mime}</span><span>·</span><span>{mb(file.size_bytes)} MB</span>
          {file.uploaded_by && <><span>·</span><span>{file.uploaded_by}</span></>}
        </div>

        <div className="min-h-[60vh] overflow-hidden rounded-2xl border border-white/70 bg-white/60">
          {kind === 'pdf' && url && (
            <iframe title={file.file_name} src={url} className="h-[70vh] w-full" />
          )}
          {kind === 'image' && url && (
            <div className="flex h-[70vh] items-center justify-center overflow-auto p-4">
              <img src={url} alt={file.file_name} className="max-h-full max-w-full object-contain" />
            </div>
          )}
          {kind === 'none' && (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center">
              <FileQuestion className="h-10 w-10 text-[#1D1D1F]/30" />
              <div className="text-sm text-[#1D1D1F]/70">
                Preview not supported — {file.mime || 'unknown type'}, {mb(file.size_bytes)} MB
              </div>
              <a href={dl}><Button>Download</Button></a>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <a href={dl}><Button variant="secondary"><Download className="h-4 w-4" /> Download</Button></a>
          {kind !== 'none' && url && (
            <>
              <a href={url} target="_blank" rel="noreferrer">
                <Button variant="secondary"><ExternalLink className="h-4 w-4" /> Open in new window</Button>
              </a>
              {kind === 'pdf' && (
                <Button variant="secondary" onClick={() => window.open(url, '_blank')?.print()}>
                  <Printer className="h-4 w-4" /> Print
                </Button>
              )}
            </>
          )}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}><X className="h-4 w-4" /> Close</Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Match the real `ui.jsx` and `api.js` exports**

```bash
grep -n "export function Modal\|export function Button\|wide" client/src/components/ui.jsx | head
grep -n "url" client/src/api.js | head
```
`Modal`'s `wide` prop and `api.url()` are assumed. If either does not exist, use what does — a wider modal can be a class, and an absolute URL can be built from the same base `api.js` already uses. **Redirect endpoints must be hit as plain URLs, not through the JSON fetch helper**, or the 302 will be followed into a JSON parse error.

- [ ] **Step 3: Verify the build**

```bash
npm run build -w client
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/FileViewer.jsx
git commit -m "feat(files): preview PDFs and images in-app, download the rest"
```

---

## Task 10: The repository editor

**Files:**
- Create: `client/src/components/ProductFiles.jsx`
- Modify: `client/src/pages/Masters.jsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/ProductFiles.jsx`:

```jsx
// ─── Product Master file repository ──────────────────────────────────────────
// Five single-file slots plus an open Supporting drawer. Empty slots are shown
// rather than hidden — "No approved artwork yet" is information the plant acts
// on. Every version ever promoted stays in the history disclosure.
import { useCallback, useEffect, useState } from 'react';
import { Upload, History, Archive, RotateCcw, Eye, Download, Loader2 } from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { Button, Modal, Input } from './ui.jsx';
import FileViewer from './FileViewer.jsx';
import { uploadFile, pickError, CATEGORY_LABEL } from '../lib/upload.js';

const mb = n => (n / (1024 * 1024)).toFixed(1);

export default function ProductFiles({ productId }) {
  const [slots, setSlots] = useState([]);
  const [busy, setBusy] = useState(null);        // category currently uploading
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [openHistory, setOpenHistory] = useState({});
  const [reasonFor, setReasonFor] = useState(null); // { category, file }
  const [reason, setReason] = useState('');

  const canMaster = +(auth.user()?.master_files ?? 0) === 1;

  const load = useCallback(async () => {
    const r = await api.get(`/products/${productId}/files`);
    setSlots(r.slots);
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  // Replacing an existing version asks for a reason first; filling an empty
  // slot does not — there is nothing being replaced to explain.
  function onPick(slot, file) {
    setErr(null);
    const e = pickError(slot.category, file);
    if (e) return setErr(e);
    if (slot.active.length && slot.slot) {
      setReason('');
      return setReasonFor({ category: slot.category, file });
    }
    doUpload(slot.category, file, null);
  }

  async function doUpload(category, file, why) {
    setBusy(category); setPct(0); setErr(null); setReasonFor(null);
    try {
      const { file: uploaded } = await uploadFile({
        file, category, productId, onProgress: setPct,
      });
      await api.post(`/products/${productId}/files/promote`, {
        file_id: uploaded.id, category, reason: why,
      });
      await load();
    } catch (e) {
      setErr(e.message || 'Upload failed');
    } finally {
      setBusy(null); setPct(0);
    }
  }

  async function archive(v) {
    if (!confirm(`Archive ${CATEGORY_LABEL[v.category]} v${v.version_no}?`)) return;
    await api.post(`/product-files/${v.id}/archive`, {});
    await load();
  }

  async function restore(v) {
    await api.post(`/product-files/${v.id}/restore`, { reason: `Restored v${v.version_no}` });
    await load();
  }

  return (
    <div className="flex flex-col gap-3">
      {err && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {slots.map(slot => (
        <div key={slot.category} className="ci-line-item">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-[#1D1D1F]">{slot.label}</div>
            <div className="flex items-center gap-2">
              {slot.history.length > 0 && (
                <Button variant="secondary"
                  onClick={() => setOpenHistory(h => ({ ...h, [slot.category]: !h[slot.category] }))}>
                  <History className="h-4 w-4" /> {slot.history.length} older
                </Button>
              )}
              {canMaster && (
                <label>
                  <input type="file" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(slot, f); }} />
                  <Button as="span" disabled={busy === slot.category}>
                    {busy === slot.category
                      ? <><Loader2 className="h-4 w-4 animate-spin" /> {Math.round(pct * 100)}%</>
                      : <><Upload className="h-4 w-4" /> {slot.active.length && slot.slot ? 'Replace' : 'Upload'}</>}
                  </Button>
                </label>
              )}
            </div>
          </div>

          {slot.active.length === 0 && (
            <div className="mt-2 text-xs text-[#1D1D1F]/50">
              No {slot.label.toLowerCase()} yet
            </div>
          )}

          {slot.active.map(v => (
            <div key={v.id} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-600">
                MASTER · v{v.version_no}
              </span>
              <span className="font-medium text-[#1D1D1F]">{v.file_name}</span>
              <span className="text-[#1D1D1F]/50">{mb(v.size_bytes)} MB</span>
              <span className="text-[#1D1D1F]/50">{v.created_by} · {fmt.dt(v.created_at)}</span>
              <div className="flex-1" />
              <Button variant="secondary" onClick={() => setViewing(v)}>
                <Eye className="h-4 w-4" /> Preview
              </Button>
              <a href={api.url(`/files/${v.file_id}/download`)}>
                <Button variant="secondary"><Download className="h-4 w-4" /></Button>
              </a>
              {canMaster && (
                <Button variant="secondary" onClick={() => archive(v)}>
                  <Archive className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}

          {openHistory[slot.category] && slot.history.map(v => (
            <div key={v.id} className="mt-1 flex flex-wrap items-center gap-2 border-t border-white/60 pt-1 text-xs text-[#1D1D1F]/60">
              <span>v{v.version_no}</span>
              <span>{v.file_name}</span>
              <span>{v.created_by} · {fmt.dt(v.created_at)}</span>
              {v.replace_reason && <span className="italic">“{v.replace_reason}”</span>}
              <div className="flex-1" />
              <Button variant="secondary" onClick={() => setViewing(v)}>
                <Eye className="h-4 w-4" />
              </Button>
              {canMaster && (
                <Button variant="secondary" onClick={() => restore(v)}>
                  <RotateCcw className="h-4 w-4" /> Restore
                </Button>
              )}
            </div>
          ))}
        </div>
      ))}

      <Modal open={!!reasonFor} onClose={() => setReasonFor(null)} title="Replace the master file?"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setReasonFor(null)}>Cancel</Button>
            <Button onClick={() => doUpload(reasonFor.category, reasonFor.file, reason)}>
              Replace
            </Button>
          </div>
        }>
        <div className="flex flex-col gap-2 text-sm">
          <div>
            The current version will be archived and stay viewable in this slot's history.
          </div>
          <Input label="Reason (optional)" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. customer revised the barcode panel" />
        </div>
      </Modal>

      <FileViewer file={viewing} open={!!viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
```

- [ ] **Step 2: Mount it in Masters → Products**

In `client/src/pages/Masters.jsx`, import the component and render it inside the product edit form, below the existing fields:

```jsx
import ProductFiles from '../components/ProductFiles.jsx';
```
```jsx
{editing?.id && (
  <div className="mt-4">
    <div className="mb-2 text-sm font-semibold text-[#1D1D1F]">Master Files</div>
    <ProductFiles productId={editing.id} />
  </div>
)}
```

Find the products form first — the exact variable name for the row being edited may not be `editing`:

```bash
grep -n "products" client/src/pages/Masters.jsx | head -20
```

- [ ] **Step 3: Match `Button`/`Input`/`Modal` props**

`Button as="span"`, `Modal footer`, and `Input label` are assumed above. Check what `ui.jsx` really supports and adapt:

```bash
grep -n "export function Button\|export function Modal\|export function Input" client/src/components/ui.jsx
```

- [ ] **Step 4: Verify in the running app**

```bash
npm run dev
```
Sign in, open **Masters → Products**, edit a product. Confirm, at a desktop breakpoint:
- five slot cards plus Supporting, all shown even when empty
- uploading a PDF shows a moving percentage, then a `MASTER · v1` chip
- uploading a second file asks for a reason, then shows `v2` with `1 older`
- the history disclosure lists v1 with its reason, and Restore produces `v3`
- Preview opens the PDF inline; Download saves it under its real filename
- signing in as a user **without** `master_files` shows no Upload, Replace, Archive or Restore

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ProductFiles.jsx client/src/pages/Masters.jsx
git commit -m "feat(files): the Product Master file repository editor"
```

---

## Task 11: The permission checkbox

**Files:**
- Modify: `client/src/pages/Masters.jsx` (Users tab)

- [ ] **Step 1: Add the checkbox**

Find where `xs_approver` is rendered in the Users form and add `master_files` beside it, with the same control:

```bash
grep -n "xs_approver" client/src/pages/Masters.jsx
```

Copy that control, changing the field to `master_files` and the label to **"Master Files"** with the helper text *"May promote and replace official product files (approved artwork, output files)."*

- [ ] **Step 2: Verify in the running app**

Open **Masters → Users**, tick Master Files for a test user, save, sign in as them, and confirm the Upload button now appears in Masters → Products.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Masters.jsx
git commit -m "feat(files): grant Master Files permission from Masters → Users"
```

---

## Task 12: Production storage

**Files:**
- Modify: `.env.example`
- Modify: `scripts/backup-prod.mjs`

- [ ] **Step 1: Document the variables**

Append to `.env.example`:

```
# ─── File storage ────────────────────────────────────────────────────────────
# LEAVE UNSET FOR LOCAL DEVELOPMENT. With no DATABASE_URL the driver defaults to
# `local`, writing to server/.filestore — zero setup, same as the embedded PG.
#
# Production (set in Vercel, NOT here): FILE_STORAGE=supabase plus the project
# URL and its SERVICE ROLE key. The service key must never reach the client
# bundle; it is read only by server/src/storage.js.
# FILE_STORAGE=supabase
# SUPABASE_URL=https://ylbfeptgefzimcqnwphy.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=
# SUPABASE_BUCKET=ci-files
```

- [ ] **Step 2: Extend the backup script**

`npm run db:backup` dumps the database. It does **not** cover object storage, which would make a promoted approved artwork the only thing in the ERP with no backup — and the one thing that cannot be re-derived from anywhere else.

Read the existing script first, then add a bucket pass that lists `ci-files` via the Storage REST API and downloads each object under `backups/files/<timestamp>/<key>`:

```bash
sed -n '1,60p' scripts/backup-prod.mjs
```

Reuse `createSupabaseDriver` from `server/src/storage.js` for `getUrl`/`read` rather than re-implementing the REST calls.

- [ ] **Step 3: These steps need Anik — do not attempt them**

Report to the user rather than doing these:
1. Create the **private** bucket `ci-files` in Supabase project `colour-impressions-prod`.
2. Add `FILE_STORAGE=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` to Vercel **production** env.
3. Decide who else gets the `master_files` flag — it seeds to `md@` and `plant@`, but whoever runs DTP holds the approved files in practice.

- [ ] **Step 4: Apply the migration to production**

Following `DEPLOYMENT.md` §3:

```bash
npm run db:backup
npm run db:check
npm run verify
```
Then create `supabase/migrations/0010_master_files.sql` containing exactly the SQL block from Task 4, and apply it. Confirm the target project ref in the terminal output before applying.

- [ ] **Step 5: Verify production**

```bash
curl -I -L https://motionci.in
curl -sS https://motionci.in/api/health
```
Then sign in to `motionci.in`, open Masters → Products, and upload a **real** output file over 10 MB. That single upload is the proof the whole design works — it is the case the 4 MB ceiling made impossible.

- [ ] **Step 6: Commit**

```bash
git add .env.example scripts/backup-prod.mjs supabase/migrations/0010_master_files.sql
git commit -m "feat(files): production storage, and back the bucket up too"
```

---

## Self-review notes

Checked against the spec:

| Spec section | Covered by |
|---|---|
| §3 data model (`files`, `product_files`, `file_downloads`, `master_files`) | Task 4 |
| §3 `record_files` | **Plan 2** — deliberately deferred |
| §4 storage layer, both drivers, TTLs | Task 3 |
| §5 three-leg upload, size ceilings, checksum threshold, lazy GC | Tasks 1, 6, 8 |
| §6 the *Update Master?* prompt | **Plan 2** — the predicate is built and tested here (Task 1), the modal is Plan 2 |
| §7 pinning and drift | **Plan 2** — `driftFor` is built and tested here (Task 2) |
| §8 API — file lifecycle + product repository | Tasks 6, 7 |
| §8 API — record endpoints | **Plan 2** |
| §9 `FileViewer`, repository editor | Tasks 9, 10 |
| §9 `FilePanel` and the nine mount points | **Plan 2** |
| §10 two tiers, no admin bypass | Tasks 4, 5, 7, 11 |
| §11 audit under `entity='product'` | Task 7 |
| §12 failure modes | Task 6 (GC, missing object, size mismatch), Task 7 (structured 409) |
| §13 testing | Tasks 1, 2, 3 |
| §15 deployment, bucket backup | Task 12 |

**Known assumptions to check on contact with the code**, each flagged inline at the step that uses it: `tx`'s callback shape (Task 7 Step 2), `api.post`/`api.get`/`api.url`/`auth.user`/`auth.token` (Tasks 8, 9, 10), `Button`/`Modal`/`Input` props (Tasks 9, 10), and the products form variable in `Masters.jsx` (Task 10). Each has a `grep` step immediately before it rather than being assumed silently.
