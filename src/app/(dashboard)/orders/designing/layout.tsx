import { ErrorBoundary } from '@/components/ErrorBoundary'

export default function DesigningSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0">
      <ErrorBoundary moduleName="Artwork queue">{children}</ErrorBoundary>
    </div>
  )
}
