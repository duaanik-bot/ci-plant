'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
  /** Shown in the fallback (e.g. "Planning", "Artwork queue"). */
  moduleName?: string
}

type ErrorBoundaryState = {
  hasError: boolean
  error: Error | null
}

/**
 * Catches render errors in children and shows a localized fallback so the rest of the app keeps running.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.moduleName ?? 'module', error.message, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      const label = this.props.moduleName ?? 'This section'
      return (
        <div
          className="rounded-lg border border-slate-200 bg-card p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900"
          role="alert"
        >
          <p className="text-base font-semibold text-slate-900 dark:text-slate-50">Widget failed to load</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            {label} encountered an unexpected error. You can try again or refresh the page.
          </p>
          {this.state.error?.message ? (
            <p className="mt-3 font-designing-queue text-xs text-slate-500 dark:text-slate-500 break-all">
              {this.state.error.message}
            </p>
          ) : null}
          <button
            type="button"
            className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-blue-700"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
