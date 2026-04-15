/**
 * Verifies: a die issued to a machine cannot be issued again until received (return to rack).
 *
 * Run: npx tsx scripts/inventory-hub-issue-test.ts
 * Requires: DATABASE_URL, seeded machine + user + at least one dye in in_stock.
 */

import { db } from '../src/lib/db'
import { issueToolToMachine, receiveToolFromFloor } from '../src/lib/inventory-hub-service'
import { CUSTODY_IN_STOCK } from '../src/lib/inventory-hub-custody'

async function main() {
  const machine = await db.machine.findFirst()
  const operator = await db.user.findFirst({ where: { active: true } })
  if (!machine || !operator) {
    console.error('Need at least one machine and one active user in the database.')
    process.exit(1)
  }

  let dye = await db.dye.findFirst({
    where: { active: true, custodyStatus: CUSTODY_IN_STOCK },
  })

  if (!dye) {
    console.error('No in_stock dye found. Create one or reset custody on a dye to in_stock.')
    process.exit(1)
  }

  // Ensure clean state for this dye
  await db.dye.update({
    where: { id: dye.id },
    data: {
      custodyStatus: CUSTODY_IN_STOCK,
      issuedMachineId: null,
      issuedOperator: null,
      issuedAt: null,
    },
  })

  const first = await issueToolToMachine('die', dye.id, machine.id, operator.id)
  if (!first.ok) {
    console.error('First issue should succeed', first)
    process.exit(1)
  }

  const second = await issueToolToMachine('die', dye.id, machine.id, operator.id)
  if (second.ok || second.code !== 'ALREADY_ISSUED') {
    console.error('Second issue should fail with ALREADY_ISSUED', second)
    process.exit(1)
  }

  const recv = await receiveToolFromFloor('die', dye.id, 100, 'Good')
  if (!recv.ok) {
    console.error('Receive should succeed', recv)
    process.exit(1)
  }

  const third = await issueToolToMachine('die', dye.id, machine.id, operator.id)
  if (!third.ok) {
    console.error('Issue after receive should succeed', third)
    process.exit(1)
  }

  await receiveToolFromFloor('die', dye.id, 0, 'Good')
  await db.dye.update({
    where: { id: dye.id },
    data: {
      custodyStatus: CUSTODY_IN_STOCK,
      issuedMachineId: null,
      issuedOperator: null,
      issuedAt: null,
    },
  })

  console.log('OK: double-issue blocked; receive clears; issue works again.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
