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
  const callbackUrl = searchParams.get('callbackUrl') ?? '/'

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
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md">
        {/* Branding */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Colour Impressions
          </h1>
          <p className="text-slate-400 mt-1 text-sm">
            Plant Management System · Patiala
          </p>
        </div>

        {/* Card */}
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl shadow-xl p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Sign in</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2.5 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label htmlFor="pin" className="block text-sm font-medium text-slate-300 mb-1">
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
                className="w-full px-3 py-2.5 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-mono text-lg tracking-widest"
                placeholder="••••••"
              />
            </div>
            {error && (
              <p className="text-sm text-red-400 bg-red-900/30 border border-red-800 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-primary hover:bg-primary/90 disabled:bg-muted disabled:cursor-not-allowed text-primary-foreground font-medium transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-500 text-xs mt-6">
          © Colour Impressions. Authorised personnel only.
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-400">Loading…</div>}>
      <LoginForm />
    </Suspense>
  )
}
