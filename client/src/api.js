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
  date: s => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'),
  dt: s => (s ? new Date(typeof s === 'string' ? s.replace(' ', 'T') : s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  title: s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  stage: s => (s === 'qc' ? 'QC' : s === 'ctp' ? 'CTP' : (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())),
};
