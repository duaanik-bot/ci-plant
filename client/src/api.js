// Tiny API client — bearer token + central error/401 handling.
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
    // Structured decision errors (data.code) are handled by the caller with a
    // proper modal — no toast. Plain errors keep the central toast.
    if (!data.code) onError(msg);
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
      if (!data.code) onError(msg);
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
