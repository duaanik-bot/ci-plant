/**
 * Hub QA checks (run: npx tsx scripts/hub-qa-test.ts)
 * - Null-safety: empty artwork / Zod dispatch body
 * - Idempotency: duplicate dispatch key within 5s
 * - UI: Plate hub shows In-house CTP; Die hub does not
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { validatePayload } from '../src/lib/validate-hub-payload'
import { toolingHubDispatchBodySchema } from '../src/lib/tooling-hub-dispatch-schema'
import {
  buildDispatchDedupeKey,
  isRecentDuplicateDispatch,
  recordDispatchSuccess,
  __resetDispatchIdempotencyForTests,
} from '../src/lib/tooling-hub-idempotency'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

let failed = 0
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`)
  }
}

console.log('\n[Hub QA] Null-safety (validatePayload)')
ok(
  'empty artworkId is invalid',
  validatePayload({ artworkId: '', jobCardId: 'jc', setNumber: '1' }).ok === false,
)
ok(
  'empty jobCardId is invalid',
  validatePayload({ artworkId: 'aw', jobCardId: '', setNumber: '1' }).ok === false,
)
ok(
  'empty setNumber is invalid',
  validatePayload({ artworkId: 'aw', jobCardId: 'jc', setNumber: '' }).ok === false,
)
ok(
  'all three present is valid',
  validatePayload({ artworkId: 'a', jobCardId: 'b', setNumber: '1' }).ok === true,
)

console.log('\n[Hub QA] Zod dispatch guard (empty artwork)')
const badDispatch = toolingHubDispatchBodySchema.safeParse({
  toolType: 'DIE',
  artworkId: '',
  jobCardId: '00000000-0000-4000-8000-000000000099',
  setNumber: '1',
  source: 'NEW',
})
ok('empty artworkId rejected by Zod', badDispatch.success === false, badDispatch.success ? 'unexpected success' : undefined)

console.log('\n[Hub QA] Idempotency (5s window)')
__resetDispatchIdempotencyForTests()
const userId = 'user-1'
const parts = {
  toolType: 'DIE' as const,
  jobCardId: '00000000-0000-4000-8000-000000000001',
  artworkId: '00000000-0000-4000-8000-000000000002',
  setNumber: '01',
  source: 'NEW' as const,
}
const key = buildDispatchDedupeKey(userId, parts)
ok('first dispatch not duplicate', isRecentDuplicateDispatch(key) === false)
recordDispatchSuccess(key)
ok('immediate replay is duplicate', isRecentDuplicateDispatch(key) === true)

console.log('\n[Hub QA] Type-switch (Plate vs Die decision strips)')
const platePath = path.join(root, 'src/components/hub/HubPlateDecisionStrip.tsx')
const diePath = path.join(root, 'src/components/hub/HubDieDecisionStrip.tsx')
const plateSrc = fs.readFileSync(platePath, 'utf8')
const dieSrc = fs.readFileSync(diePath, 'utf8')
ok('Plate strip mentions In-house CTP', plateSrc.includes('In-house CTP'))
ok('Die strip does not offer In-house CTP', !dieSrc.includes('In-house'))

console.log('')
if (failed > 0) {
  console.error(`[Hub QA] FAILED (${failed} assertion(s))\n`)
  process.exit(1)
}
console.log('[Hub QA] All checks passed.\n')
process.exit(0)
