// Centred login card — the front door.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../api.js';
import { Button, Field, Input } from '../components/ui.jsx';
import { Package } from 'lucide-react';

export default function Login() {
  const nav = useNavigate();
  // Dev convenience: prefill the seeded demo admin so local sign-in is one click.
  const [email, setEmail] = useState(import.meta.env.DEV ? 'admin@ci.local' : '');
  const [password, setPassword] = useState(import.meta.env.DEV ? 'admin123' : '');
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* Tahoe desktop glow the glass card refracts */}
      <div className="pointer-events-none absolute -top-44 left-1/2 h-[28rem] w-[46rem] -translate-x-1/2 rounded-full bg-[#0A84FF]/[0.14] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-56 left-[12%] h-96 w-96 rounded-full bg-[#AF52DE]/[0.10] blur-3xl" />
      <div className="pointer-events-none absolute right-[6%] top-1/3 h-72 w-72 rounded-full bg-[#34C759]/[0.08] blur-3xl" />
      <div className="relative w-full max-w-sm animate-slideUp">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-b from-[#2E95FF] to-[#007AFF] shadow-[0_10px_24px_rgba(0,122,255,0.35),inset_0_1px_0_rgba(255,255,255,0.45)]">
            <Package size={20} className="text-white" />
          </span>
          <div>
            <div className="text-lg font-bold tracking-[-0.02em] text-[#1D1D1F]">Colour Impressions</div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#86868B]">Plant ERP</div>
          </div>
        </div>
        <form onSubmit={submit} className="glass rounded-[28px] p-6">
          <h1 className="mb-4 text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">Sign in</h1>
          <div className="space-y-3">
            <Field label="Email" required>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@ci.local" autoFocus />
            </Field>
            <Field label="Password" required>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            {error && <p className="rounded-xl bg-red-50/90 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
            <Button size="lg" className="w-full" disabled={loading || !email || !password}>
              {loading ? 'Signing in…' : 'Sign In'}
            </Button>
          </div>
        </form>
        <p className="mt-4 text-center text-xs text-[#86868B]">
          First time? Default admin: <span className="font-mono">admin@ci.local / admin123</span>
        </p>
      </div>
    </div>
  );
}
