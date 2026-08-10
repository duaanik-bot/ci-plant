// Tiny API client — bearer token + central error/401 handling.

// Structured refusals (a `code` in the body) skip the central toast because the
// caller draws its own dialog for them. That used to be assumed of EVERY code,
// which meant a server refusal nobody had wired up produced nothing at all —
// no toast, no dialog, a button that simply did not work. PLATES_NOT_READY
// shipped exactly that way and stopped three jobs at Offset 3 in silence.
//
// So suppression is opt-in now, and this map is the opt-in: every entry names
// the caller that says the refusal itself. A code that is NOT here falls through
// to the central toast — the wrong-looking message beats no message at all, and
// a new structured error is visible from the first minute it exists.
//
// The claim used to be a trailing comment, which cannot be wrong out loud: the
// two board codes below were filed under BoardCommitments.jsx, a component that
// calls neither route. It is data now, and handled-codes.test.js proves every
// line of it. `at` is the screen that speaks; `says` is a literal that screen
// must really contain, in code and not in prose:
//
//   • the code itself — the caller branches on it and draws its own dialog.
//   • an endpoint — the caller has no branch but wraps that call in a catch
//     that toasts e.message. A generic catch is a real handler; the code simply
//     never appears by name. The test then also demands that endpoint appear in
//     the server file that throws, so the screen is provably on that route.
export const HANDLED_BY = {
  SHADE_CARD_NOT_ELIGIBLE: {
    at: ['pages/Section.jsx', 'pages/Floor.jsx', 'pages/Production.jsx'], says: 'SHADE_CARD_NOT_ELIGIBLE' },
  // StartAlarms.jsx draws the dialog, but the three pages are what branch on the
  // code — and the branch is the handler, so they are what is named here.
  PLATES_NOT_READY: {
    at: ['pages/Section.jsx', 'pages/Floor.jsx', 'pages/Production.jsx'], says: 'PLATES_NOT_READY' },
  PRODUCT_STRENGTH_COLLISION: { at: ['pages/PrintPlanning.jsx', 'pages/Invoices.jsx'], says: 'PRODUCT_STRENGTH_COLLISION' },
  GANG_CONFLICT: { at: ['pages/Planning.jsx'], says: 'GANG_CONFLICT' },
  merge_conflicts: { at: ['pages/Planning.jsx'], says: 'merge_conflicts' },
  gang_pr_exists: { at: ['pages/Planning.jsx'], says: 'gang_pr_exists' },
  // PLAN_ALREADY_EXECUTED is NOT here, and that is the point of the map. It
  // read as handled because Planning.jsx names it in a comment — but savePlan()
  // has no catch, every caller fires it from an onClick without one, and the app
  // installs no unhandledrejection handler. Suppressing it made Lock Plan on an
  // in_production line do nothing at all, while the server's refusal was already
  // naming the way out ("Reverse the job card back to Planning first").
  //
  // The discard pair below IS handled, just not by name: one catch around
  // /plan/discard toasts e.message whatever the code, which is why they anchor
  // on the endpoint instead.
  PLAN_NOT_DRAFT: { at: ['pages/Planning.jsx'], says: '/plan/discard' },
  PLAN_NEVER_SAVED: { at: ['pages/Planning.jsx'], says: '/plan/discard' },
  PLAN_DISCARD_GANGED: { at: ['pages/Planning.jsx'], says: '/plan/discard' },
  RUN_NOT_DRAFT: { at: ['pages/Planning.jsx'], says: '/plan/discard' },
  RUN_NEVER_SAVED: { at: ['pages/Planning.jsx'], says: '/plan/discard' },
  // BOARD_NOT_FREE is gone from this list ON PURPOSE, and no longer thrown at
  // all: the plan lock now caps a Board Mix's holds instead of refusing them.
  // While it sat here, nothing anywhere drew a dialog for it — so a mix that
  // outgrew free stock made Lock Plan do nothing, in total silence, which read
  // on the floor as "the wastage will not go above 200".
  //
  // These two are the planning engine's own commitBoard/uncommitBoard, each
  // ending `catch (e) { toast.error(e.message) }` — NOT BoardCommitments.jsx,
  // which only ever calls /board/move.
  COMMIT_EXCEEDS_FREE: { at: ['pages/Planning.jsx'], says: '/board/commit' },
  NOTHING_COMMITTED: { at: ['pages/Planning.jsx'], says: '/board/uncommit' },
  scanned: { at: ['components/ImportPOWizard.jsx'], says: 'scanned' },
};

export const HANDLED_CODES = new Set(Object.keys(HANDLED_BY));

let onError = () => {};
let onUnauthorized = () => {};
export function setErrorHandler(fn) { onError = fn; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export const auth = {
  get token() { return localStorage.getItem('ci_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('ci_user')); } catch { return null; } },
  set(session) {
    localStorage.setItem('ci_token', session.token);
    localStorage.setItem('ci_user', JSON.stringify(session.user));
  },
  clear() {
    localStorage.removeItem('ci_token');
    localStorage.removeItem('ci_user');
  },
};

async function request(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const res = await fetch(`/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/auth/')) {
    auth.clear();
    onUnauthorized();
    throw new Error(data.error || 'Signed out');
  }
  if (!res.ok) {
    const msg = data.error || `Request failed (${res.status})`;
    // Only a code with a caller-side dialog stays quiet — see HANDLED_CODES.
    if (!HANDLED_CODES.has(data.code)) onError(msg);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
  // Multipart upload — same auth/error handling as request(), no JSON header.
  // `extra` = additional form fields riding along with the file (doc_type…).
  async upload(url, file, extra = {}) {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') fd.append(k, v);
    const res = await fetch(`/api${url}`, {
      method: 'POST',
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      auth.clear();
      onUnauthorized();
      throw new Error(data.error || 'Signed out');
    }
    if (!res.ok) {
      const msg = data.error || `Upload failed (${res.status})`;
      if (!HANDLED_CODES.has(data.code)) onError(msg);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
};

export const fmt = {
  num: n => (n ?? 0).toLocaleString('en-IN'),
  kg: n => (n == null ? '—' : (+n).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' kg'),
  inr: n => '₹' + Math.round(n ?? 0).toLocaleString('en-IN'),
  // Lakh/crore short form for KPI tiles — a plant total runs to eight digits and
  // '₹2,44,71,905' will not fit a compact card. Always pair it with the exact
  // fmt.inr() figure on the card's title/sub so nothing is actually hidden.
  inrShort: n => {
    const v = Math.round(+n || 0);
    const a = Math.abs(v);
    const trim = x => x.toFixed(2).replace(/\.?0+$/, '');
    if (a >= 1e7) return `₹${trim(v / 1e7)} Cr`;
    // Rounding can push a lakh figure to "100 L"; that reads as a crore, so the
    // promotion is decided on the ROUNDED value, not the raw one.
    if (a >= 1e5) {
      const lakh = v / 1e5;
      return Math.abs(+lakh.toFixed(2)) >= 100 ? `₹${trim(v / 1e7)} Cr` : `₹${trim(lakh)} L`;
    }
    return '₹' + v.toLocaleString('en-IN');
  },
  // "1 line" / "2 lines". KPI sub-lines are read at a glance, and "1 lines"
  // is exactly the kind of wrongness that makes the number beside it look
  // computed by something careless. Irregular plurals pass `plural` in.
  count: (n, noun, plural) => `${fmt.num(n)} ${(+n === 1) ? noun : (plural || noun + 's')}`,
  date: s => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'),
  dt: s => (s ? new Date(typeof s === 'string' ? s.replace(' ', 'T') : s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  title: s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  stage: s => (s === 'qc' ? 'QC' : s === 'ctp' ? 'CTP' : (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())),
};
