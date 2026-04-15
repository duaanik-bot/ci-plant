import { redirect } from 'next/navigation'

/** Consolidated into the main hub — Live rack status grid. */
export default function RackViewRedirectPage() {
  redirect('/pre-press/plate-store?tab=plates')
}
