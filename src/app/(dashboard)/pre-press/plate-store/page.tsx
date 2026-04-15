import { redirect } from 'next/navigation'

/** Canonical plates tooling UI lives at `/hub/plates`. */
export default function PlateStoreRedirectPage() {
  redirect('/hub/plates')
}
