'use client'

import { useState, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'

function LoginForm() {
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const searchParams = useSearchParams()
  const callbackUrl = searchParams?.get('callbackUrl') ?? '/'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await signIn('credentials', {
        email: email.trim(),
        pin: pin.replace(/\D/g, '').slice(0, 6),
        redirect: false,
        callbackUrl,
      })
      if (res?.error) {
        setError('Invalid email or PIN. Please try again.')
        setLoading(false)
        return
      }
      if (res?.url) window.location.href = res.url
      else window.location.href = callbackUrl
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg-main)] p-4">
      <div className="w-full max-w-md">
        {/* Branding */}
        <div className="text-center mb-8">
          <h1 className="text-[22px] font-semibold text-ds-ink tracking-tight">
            Colour Impressions
          </h1>
          <p className="text-ds-ink-muted mt-1 text-sm">
            Plant Management System · Patiala
          </p>
        </div>

        {/* Card */}
        <div className="bg-ds-elevated/80 border border-ds-line/50 border-t-2 border-t-ds-brand/30 rounded-ds-lg shadow-ds-depth p-6">
          <h2 className="text-[18px] font-semibold text-ds-ink mb-4">Sign in</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-ds-ink-muted mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="ds-input ds-focus rounded-ds-sm"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label htmlFor="pin" className="block text-sm font-medium text-ds-ink-muted mb-1">
                6-digit PIN
              </label>
              <input
                id="pin"
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                required
                className="ds-input ds-focus ds-input-num rounded-ds-sm font-[var(--font-mono-code)] text-lg tracking-widest"
                placeholder="••••••"
              />
            </div>
            {error && (
              <p className="text-sm text-ds-error bg-[var(--error-bg,rgba(239,68,68,0.08))] border border-ds-error/30 rounded-ds-sm px-3 py-2">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-ds-sm bg-ds-brand hover:bg-ds-brand-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm shadow-sm transition-colors duration-150"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-ds-ink-faint text-xs mt-6">
          © Colour Impressions. Authorised personnel only.
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-ds-card text-ds-ink-muted">Loading…</div>}>
      <LoginForm />
    </Suspense>
  )
}
