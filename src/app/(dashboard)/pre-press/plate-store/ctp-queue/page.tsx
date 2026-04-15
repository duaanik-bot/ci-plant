import { redirect } from 'next/navigation'

/** Consolidated into the main hub — CTP queue section. */
export default function CtpQueueRedirectPage() {
  redirect('/pre-press/plate-store?tab=plates&section=ctp')
}
