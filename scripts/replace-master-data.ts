/**
 * scripts/replace-master-data.ts
 *
 * DESTRUCTIVE WIPE + RELOAD SCRIPT — MASTER DATA ONLY
 * =====================================================
 * Wipes and reloads: User, Role, Machine (+ dependent PM rows),
 * OperatorMaster, OperatorStationAssignment.
 *
 * USAGE
 *   npx tsx scripts/replace-master-data.ts             # DRY-RUN (safe, read-only)
 *   npx tsx scripts/replace-master-data.ts --confirm   # LIVE WRITE — destructive!
 *
 * After --confirm completes, run:
 *   npx prisma db seed
 * to reload the canonical master data.
 *
 * ─────────────────────────────────────────────────────
 * FK ANALYSIS — what this script touches and why
 * ─────────────────────────────────────────────────────
 *
 * MACHINE (machines.id) referencing columns:
 *   AUTO-DELETED (onDelete: Cascade on machine):
 *     machine_pm_schedules.machine_id
 *     preventive_maintenance_logs.machine_id
 *     pm_planned_downtime.machine_id
 *   AUTO-NULLED (onDelete: SetNull or nullable w/ SetNull):
 *     production_job_cards.machine_id        (nullable, onDelete: SetNull)
 *     production_downtime_logs.machine_id    (nullable, onDelete: SetNull)
 *     production_oee_ledgers.machine_id      (nullable, onDelete: SetNull)
 *     emboss_blocks.issued_machine_id        (nullable, onDelete: SetNull)
 *   MUST BE NULLED MANUALLY (nullable, Prisma default = Restrict):
 *     bom_lines.machine_id
 *     job_stages.machine_id
 *     waste_records.machine_id
 *
 * USER (users.id) referencing columns:
 *   AUTO-NULLED (onDelete: SetNull):
 *     preventive_maintenance_logs.verified_by_user_id  (nullable, SetNull)
 *     production_job_cards.shift_operator_user_id      (nullable, SetNull)
 *     production_oee_ledgers.attributed_operator_user_id (nullable, SetNull)
 *   AUTO-DELETED (onDelete: Cascade):
 *     production_downtime_logs.operator_user_id        (NON-NULLABLE, Cascade)
 *   MUST BE NULLED MANUALLY (nullable, Prisma default = Restrict):
 *     jobs.closed_by
 *     sheet_issues.approved_by
 *     job_stages.completed_by
 *     ncrs.assigned_to
 *     ncrs.closed_by
 *     audit_log.user_id
 *   BLOCKING — NON-NULLABLE, no onDelete (Restrict) → ABORT if rows exist:
 *     jobs.created_by             (Job.creator, NON-NULLABLE)
 *     sheet_issues.issued_by      (SheetIssue.issuer, NON-NULLABLE)
 *     job_stages.started_by       (JobStage.starter, NON-NULLABLE)
 *     qc_records.checked_by       (QcRecord.checker, NON-NULLABLE)
 *     ncrs.raised_by              (Ncr.raiser, NON-NULLABLE)
 *     waste_records.recorded_by   (WasteRecord.recorder, NON-NULLABLE)
 *     rfqs.created_by             (Rfq.creator, NON-NULLABLE)
 *
 * ROLE (roles.id) referencing columns:
 *   users.role_id — NON-NULLABLE (Restrict). Users are deleted before roles
 *   in --confirm mode, so this is handled by the user-wipe step above.
 *   If the user-wipe is blocked (jobs etc.), roles won't be touched either.
 *
 * OPERATOR (operator_master.id) referencing columns:
 *   operator_station_assignment.operator_id (onDelete: Cascade) → auto-deleted.
 *   No other tables reference OperatorMaster — safe to wipe directly.
 *
 * ─────────────────────────────────────────────────────
 * SAFETY GUARANTEE
 *   The script will ABORT (throw inside the transaction) if any of the
 *   7 BLOCKING columns above have rows. The operator must manually clear
 *   those production rows before a wipe can proceed. No silent data loss.
 * ─────────────────────────────────────────────────────
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')

// ─── helpers ──────────────────────────────────────────────────────────────────

function banner(msg: string) {
  const line = '═'.repeat(msg.length + 4)
  console.log(`\n╔${line}╗\n║  ${msg}  ║\n╚${line}╝\n`)
}

function row(label: string, count: number) {
  const flag = count > 0 ? '  ⚠' : '  ✓'
  console.log(`  ${label.padEnd(52)} ${String(count).padStart(7)}${flag}`)
}

// ─── dry-run: count & report ───────────────────────────────────────────────────

async function dryRun() {
  banner('DRY-RUN — no writes will occur')

  console.log('MASTER DATA ROWS (to be wiped):')
  const [users, operators, assignments, roles, machines] = await Promise.all([
    prisma.user.count(),
    prisma.operatorMaster.count(),
    prisma.operatorStationAssignment.count(),
    prisma.role.count(),
    prisma.machine.count(),
  ])
  console.log(`  Users                    : ${users}`)
  console.log(`  OperatorMaster           : ${operators}`)
  console.log(`  OperatorStationAssignment: ${assignments}`)
  console.log(`  Roles                    : ${roles}`)
  console.log(`  Machines                 : ${machines}`)

  console.log('\nAUTO-HANDLED (cascade / SetNull — no manual work needed):')
  const [pmSchedules, pmLogs, pmSlots, downtimeLogs] = await Promise.all([
    prisma.machinePmSchedule.count(),
    prisma.preventiveMaintenanceLog.count(),
    prisma.pmPlannedDowntime.count(),
    prisma.productionDowntimeLog.count(), // Cascade on User
  ])
  console.log(`  MachinePmSchedule (Cascade on Machine)      : ${pmSchedules}`)
  console.log(`  PreventiveMaintenanceLog (Cascade on Machine): ${pmLogs}`)
  console.log(`  PmPlannedDowntime (Cascade on Machine)      : ${pmSlots}`)
  console.log(`  ProductionDowntimeLog (Cascade on User)     : ${downtimeLogs}`)

  console.log('\nNULLABLE REFERENCES (manually nulled before delete):')
  const [
    jobsClosed,
    sheetIssuesApproved,
    jobStagesCompleted,
    ncrsAssigned,
    ncrsClosed,
    auditLogs,
    bomLinesWithMachine,
    jobStagesWithMachine,
    wasteRecordsWithMachine,
  ] = await Promise.all([
    prisma.job.count({ where: { closedBy: { not: null } } }),
    prisma.sheetIssue.count({ where: { approvedBy: { not: null } } }),
    prisma.jobStage.count({ where: { completedBy: { not: null } } }),
    prisma.ncr.count({ where: { assignedTo: { not: null } } }),
    prisma.ncr.count({ where: { closedBy: { not: null } } }),
    prisma.auditLog.count({ where: { userId: { not: null } } }),
    prisma.bomLine.count({ where: { machineId: { not: null } } }),
    prisma.jobStage.count({ where: { machineId: { not: null } } }),
    prisma.wasteRecord.count({ where: { machineId: { not: null } } }),
  ])
  row('jobs.closed_by (→ User)', jobsClosed)
  row('sheet_issues.approved_by (→ User)', sheetIssuesApproved)
  row('job_stages.completed_by (→ User)', jobStagesCompleted)
  row('ncrs.assigned_to (→ User)', ncrsAssigned)
  row('ncrs.closed_by (→ User)', ncrsClosed)
  row('audit_log.user_id (→ User)', auditLogs)
  row('bom_lines.machine_id (→ Machine)', bomLinesWithMachine)
  row('job_stages.machine_id (→ Machine)', jobStagesWithMachine)
  row('waste_records.machine_id (→ Machine)', wasteRecordsWithMachine)

  console.log('\nBLOCKING REFERENCES — NON-NULLABLE (must be 0 to wipe):')
  const [jobs, sheetIssues, jobStagesStarted, qcRecords, ncrs, wasteRecords, rfqs] =
    await Promise.all([
      prisma.job.count(),
      prisma.sheetIssue.count(),
      prisma.jobStage.count(),
      prisma.qcRecord.count(),
      prisma.ncr.count(),
      prisma.wasteRecord.count(),
      prisma.rfq.count(),
    ])
  row('jobs (created_by → User) — BLOCKS wipe', jobs)
  row('sheet_issues (issued_by → User) — BLOCKS wipe', sheetIssues)
  row('job_stages (started_by → User) — BLOCKS wipe', jobStagesStarted)
  row('qc_records (checked_by → User) — BLOCKS wipe', qcRecords)
  row('ncrs (raised_by → User) — BLOCKS wipe', ncrs)
  row('waste_records (recorded_by → User) — BLOCKS wipe', wasteRecords)
  row('rfqs (created_by → User) — BLOCKS wipe', rfqs)

  const blockers = jobs + sheetIssues + jobStagesStarted + qcRecords + ncrs + wasteRecords + rfqs
  if (blockers > 0) {
    console.log(
      `\n🚫 CANNOT WIPE: ${blockers} row(s) in blocking tables reference User records.`,
    )
    console.log(
      '   Clear (or reassign) those production rows before running --confirm.',
    )
  } else {
    console.log(
      '\n✅ No blocking rows found. Safe to run with --confirm IF you have reviewed the counts above.',
    )
  }

  console.log('\nDRY-RUN COMPLETE — no changes made.')
  console.log('To execute:  npx tsx scripts/replace-master-data.ts --confirm')
  console.log('After wipe:  npx prisma db seed')
}

// ─── confirm: destructive wipe ─────────────────────────────────────────────────

async function confirmWipe() {
  banner('⚠  LIVE WRITE MODE — THIS IS DESTRUCTIVE  ⚠')
  console.log('Deleting: OperatorStationAssignment, OperatorMaster,')
  console.log('          ProductionDowntimeLog (Cascade), Users, Roles, Machines')
  console.log('Nulling: nullable FK columns before delete where required.\n')

  await prisma.$transaction(
    async (tx) => {
      // ── 1. Check blocking rows — abort early if any exist ─────────────────
      const [jobs, sheetIssues, jobStages, qcRecords, ncrs, wasteRecords, rfqs] =
        await Promise.all([
          tx.job.count(),
          tx.sheetIssue.count(),
          tx.jobStage.count(),
          tx.qcRecord.count(),
          tx.ncr.count(),
          tx.wasteRecord.count(),
          tx.rfq.count(),
        ])

      const blocking: string[] = []
      if (jobs > 0)
        blocking.push(`  jobs (${jobs} rows) — jobs.created_by references User`)
      if (sheetIssues > 0)
        blocking.push(
          `  sheet_issues (${sheetIssues} rows) — sheet_issues.issued_by references User`,
        )
      if (jobStages > 0)
        blocking.push(
          `  job_stages (${jobStages} rows) — job_stages.started_by references User`,
        )
      if (qcRecords > 0)
        blocking.push(
          `  qc_records (${qcRecords} rows) — qc_records.checked_by references User`,
        )
      if (ncrs > 0)
        blocking.push(`  ncrs (${ncrs} rows) — ncrs.raised_by references User`)
      if (wasteRecords > 0)
        blocking.push(
          `  waste_records (${wasteRecords} rows) — waste_records.recorded_by references User`,
        )
      if (rfqs > 0)
        blocking.push(`  rfqs (${rfqs} rows) — rfqs.created_by references User`)

      if (blocking.length > 0) {
        const msg =
          '\n❌ WIPE ABORTED — non-nullable FK references to User still exist:\n' +
          blocking.join('\n') +
          '\n\nYou must clear or reassign these production rows before wiping master data.' +
          '\nNo rows have been modified. Transaction rolled back.'
        throw new Error(msg)
      }

      // ── 2. Operators — safe (only referenced by OperatorStationAssignment Cascade) ──
      const delAssignments = await tx.operatorStationAssignment.deleteMany()
      console.log(`  Deleted ${delAssignments.count} OperatorStationAssignment rows`)

      const delOperators = await tx.operatorMaster.deleteMany()
      console.log(`  Deleted ${delOperators.count} OperatorMaster rows`)

      // ── 3. Null out nullable FK columns pointing to User ──────────────────
      //    (Prisma default for nullable = Restrict, must null manually before delete)
      const [n1, n2, n3, n4, n5, n6] = await Promise.all([
        tx.job.updateMany({ where: { closedBy: { not: null } }, data: { closedBy: null } }),
        tx.sheetIssue.updateMany({
          where: { approvedBy: { not: null } },
          data: { approvedBy: null },
        }),
        tx.jobStage.updateMany({
          where: { completedBy: { not: null } },
          data: { completedBy: null },
        }),
        tx.ncr.updateMany({ where: { assignedTo: { not: null } }, data: { assignedTo: null } }),
        tx.ncr.updateMany({ where: { closedBy: { not: null } }, data: { closedBy: null } }),
        tx.auditLog.updateMany({ where: { userId: { not: null } }, data: { userId: null } }),
      ])
      console.log(
        `  Nulled nullable User FKs: jobs.closed_by(${n1.count}), sheet_issues.approved_by(${n2.count}), ` +
          `job_stages.completed_by(${n3.count}), ncrs.assigned_to(${n4.count}), ncrs.closed_by(${n5.count}), ` +
          `audit_log.user_id(${n6.count})`,
      )

      // ── 4. Null out nullable FK columns pointing to Machine ───────────────
      //    (bom_lines, job_stages, waste_records — Prisma default = Restrict)
      const [m1, m2, m3] = await Promise.all([
        tx.bomLine.updateMany({ where: { machineId: { not: null } }, data: { machineId: null } }),
        tx.jobStage.updateMany({
          where: { machineId: { not: null } },
          data: { machineId: null },
        }),
        tx.wasteRecord.updateMany({
          where: { machineId: { not: null } },
          data: { machineId: null },
        }),
      ])
      console.log(
        `  Nulled nullable Machine FKs: bom_lines(${m1.count}), job_stages(${m2.count}), waste_records(${m3.count})`,
      )

      // ── 5. Delete users (ProductionDowntimeLog.operator_user_id cascades automatically) ──
      const delUsers = await tx.user.deleteMany()
      console.log(`  Deleted ${delUsers.count} User rows (ProductionDowntimeLogs cascaded)`)

      // ── 6. Delete roles (users.role_id is now clear) ──────────────────────
      const delRoles = await tx.role.deleteMany()
      console.log(`  Deleted ${delRoles.count} Role rows`)

      // ── 7. Delete machines (MachinePmSchedule, PreventiveMaintenanceLog,
      //       PmPlannedDowntime cascade; SetNull FKs nulled automatically by DB;
      //       bom_lines/job_stages/waste_records machine FKs already nulled above) ─
      const delMachines = await tx.machine.deleteMany()
      console.log(
        `  Deleted ${delMachines.count} Machine rows (PM schedules/logs/slots cascaded; SetNull FKs auto-nulled)`,
      )
    },
    { timeout: 60_000 },
  )

  banner('WIPE COMPLETE')
  console.log('Next step — reload master data:')
  console.log('  npx prisma db seed\n')
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    if (CONFIRM) {
      await confirmWipe()
    } else {
      await dryRun()
    }
  } catch (err) {
    console.error('\n' + (err instanceof Error ? err.message : String(err)))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
