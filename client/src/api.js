// Tiny API client — every call funnels errors to the toast layer.
let onError = () => {};
export function setErrorHandler(fn) { onError = fn; }

async function request(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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
  dt: s => (s ? new Date(s.replace(' ', 'T')).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  title: s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
};
