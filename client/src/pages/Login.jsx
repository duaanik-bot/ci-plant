// Centred login card — the front door.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../api.js';
import { Button, Field, Input } from '../components/ui.jsx';
import { Package } from 'lucide-react';

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const session = await api.post('/auth/login', { email, password });
      auth.set(session);
      nav('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-900 p-4">
      <div className="w-full max-w-sm animate-slideUp">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500">
            <Package size={20} className="text-white" />
          </span>
          <div>
            <div className="text-lg font-extrabold tracking-wide text-white">COLOUR IMPRESSIONS</div>
            <div className="text-xs font-medium text-gray-400">Plant ERP</div>
          </div>
        </div>
        <form onSubmit={submit} className="rounded-2xl bg-white p-6 shadow-modal">
          <h1 className="mb-4 text-base font-bold text-gray-900">Sign in</h1>
          <div className="space-y-3">
            <Field label="Email" required>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@ci.local" autoFocus />
            </Field>
            <Field label="Password" required>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
            <Button size="lg" className="w-full" disabled={loading || !email || !password}>
              {loading ? 'Signing in…' : 'Sign In'}
            </Button>
          </div>
        </form>
        <p className="mt-4 text-center text-xs text-gray-500">
          First time? Default admin: <span className="font-mono">admin@ci.local / admin123</span>
        </p>
      </div>
    </div>
  );
}
