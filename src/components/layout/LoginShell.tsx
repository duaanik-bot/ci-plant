'use client'

import { useState, type ElementType, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * LoginShell
 * ───────────
 * A centred login card layout — wire your own auth logic into it.
 *
 * Visual design:
 *   • Page bg:   ds-main (matches app theme)
 *   • Card:      ds-card, rounded-ds-md, soft border + shadow
 *   • Logo tile: orange-500 rounded-xl above the card
 *
 * Usage (Next.js, next-auth credentials):
 *   import { Cpu } from 'lucide-react'
 *   <LoginShell
 *     appName="Colour Impressions"
 *     tagline="Sign in to continue"
 *     logoIcon={Cpu}
 *     onSubmit={async ({ email, password }) => signIn('credentials', { email, password })}
 *     error={loginError}
 *     loading={isLoading}
 *   />
 */

interface LoginShellProps {
  appName?: string
  tagline?: string
  logoIcon?: ElementType
  onSubmit?: (creds: { email: string; password: string }) => void | Promise<void>
  loading?: boolean
  error?: string
}

export function LoginShell({
  appName   = 'Colour Impressions',
  tagline   = 'Sign in to continue',
  logoIcon: LogoIcon,
  onSubmit,
  loading   = false,
  error     = '',
}: LoginShellProps) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    onSubmit?.({ email, password })
  }

  return (
    <div className="min-h-screen bg-ds-main flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Logo + title */}
        <div className="text-center mb-8">
          {LogoIcon && (
            <div className="inline-flex items-center justify-center w-12 h-12 bg-orange-500 rounded-xl mb-4 shadow-md">
              <LogoIcon size={24} className="text-white" />
            </div>
          )}
          <h1 className="text-2xl font-bold text-ds-ink">{appName}</h1>
          <p className="text-ds-ink-muted text-sm mt-1">{tagline}</p>
        </div>

        {/* Card */}
        <div className="bg-ds-card rounded-ds-md shadow-card border border-ds-line p-6">
          <form onSubmit={handleSubmit} className="space-y-4">

            <div className="space-y-1">
              <label className="block text-xs font-medium text-ds-ink-muted">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
                className="
                  w-full px-3 py-2 rounded-ds-sm border border-ds-line text-sm outline-none
                  bg-ds-card text-ds-ink placeholder:text-ds-ink-faint
                  focus:ring-2 focus:ring-ds-brand/15 focus:border-ds-brand transition-colors
                "
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-medium text-ds-ink-muted">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="
                  w-full px-3 py-2 rounded-ds-sm border border-ds-line text-sm outline-none
                  bg-ds-card text-ds-ink
                  focus:ring-2 focus:ring-ds-brand/15 focus:border-ds-brand transition-colors
                "
              />
            </div>

            {error && (
              <p className="text-sm text-ds-error bg-ds-error/8 rounded-ds-sm px-3 py-2 border border-ds-error/20">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="
                w-full flex items-center justify-center gap-2 bg-ds-brand text-white
                py-2 rounded-ds-sm text-sm font-medium hover:bg-ds-brand-hover disabled:opacity-60
                transition-colors cursor-pointer
              "
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              Sign In
            </button>
          </form>
        </div>

      </div>
    </div>
  )
}

export default LoginShell
