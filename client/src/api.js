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
    onError(msg);
    throw new Error(msg);
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: url => request('DELETE', url),
};

export const fmt = {
  num: n => (n ?? 0).toLocaleString('en-IN'),
  inr: n => '₹' + Math.round(n ?? 0).toLocaleString('en-IN'),
  date: s => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'),
  dt: s => (s ? new Date(typeof s === 'string' ? s.replace(' ', 'T') : s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  title: s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  stage: s => (s === 'qc' ? 'QC' : (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())),
};
