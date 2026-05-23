import { db } from '@/lib/db'

// Canonical 23-stage pharma workflow (includes Sorting after Die Cutting)
export const WORKFLOW_DEFINITION: {
  stageNumber: number
  stageName: string
  responsibleRole?: string
}[] = [
  { stageNumber: 1, stageName: 'Client RFQ / Packaging Requirement', responsibleRole: 'sales' },
  { stageNumber: 2, stageName: 'Technical & Commercial Feasibility Review', responsibleRole: 'plant_head' },
  { stageNumber: 3, stageName: 'Quotation Submission & Client Approval', responsibleRole: 'sales' },
  { stageNumber: 4, stageName: 'Purchase Order Received', responsibleRole: 'sales' },
  { stageNumber: 5, stageName: 'Artwork & Regulatory Approval', responsibleRole: 'design_planning' },
  { stageNumber: 6, stageName: 'Bill of Materials Creation', responsibleRole: 'design_planning' },
  { stageNumber: 7, stageName: 'Raw Material Procurement', responsibleRole: 'accounts' },
  { stageNumber: 8, stageName: 'Incoming Quality Inspection', responsibleRole: 'plant_head' },
  { stageNumber: 9, stageName: 'Raw Material Storage', responsibleRole: 'accounts' },
  { stageNumber: 10, stageName: 'Production Planning', responsibleRole: 'design_planning' },
  { stageNumber: 11, stageName: 'Pre-Press Operations', responsibleRole: 'design_planning' },
  { stageNumber: 12, stageName: 'Printing', responsibleRole: 'production' },
  { stageNumber: 13, stageName: 'In-Process Quality Check', responsibleRole: 'plant_head' },
  { stageNumber: 14, stageName: 'Post-Printing Processing', responsibleRole: 'production' },
  { stageNumber: 15, stageName: 'Die Cutting / Conversion', responsibleRole: 'production' },
  { stageNumber: 16, stageName: 'Sorting', responsibleRole: 'production' },
  { stageNumber: 17, stageName: 'Folding & Gluing', responsibleRole: 'production' },
  { stageNumber: 18, stageName: 'Final Quality Inspection (QA)', responsibleRole: 'plant_head' },
  { stageNumber: 19, stageName: 'Batch Documentation & Release', responsibleRole: 'plant_head' },
  { stageNumber: 20, stageName: 'Packing & Palletisation', responsibleRole: 'accounts' },
  { stageNumber: 21, stageName: 'Finished Goods Warehouse', responsibleRole: 'accounts' },
  { stageNumber: 22, stageName: 'Dispatch Planning', responsibleRole: 'dispatch' },
  { stageNumber: 23, stageName: 'Shipping & Delivery Confirmation', responsibleRole: 'dispatch' },
]

/** Total number of workflow stages (pharma job workflow) */
export const WORKFLOW_STAGE_COUNT = WORKFLOW_DEFINITION.length

export async function initializeWorkflowForJob(jobId: string) {
  const existing = await db.workflowStage.findMany({ where: { jobId } })
  if (existing.length) return existing

  const now = new Date()

  await db.workflowStage.createMany({
    data: WORKFLOW_DEFINITION.map((s) => ({
      jobId,
      stageNumber: s.stageNumber,
      stageName: s.stageName,
      responsibleRole: s.responsibleRole,
      status: s.stageNumber === 1 ? 'in_progress' : 'pending',
      actualStart: s.stageNumber === 1 ? now : null,
    })),
  })

  return db.workflowStage.findMany({
    where: { jobId },
    orderBy: { stageNumber: 'asc' },
  })
}

export async function getWorkflowForJob(jobId: string) {
  return db.workflowStage.findMany({
    where: { jobId },
    orderBy: { stageNumber: 'asc' },
  })
}

export async function completeWorkflowStage(params: {
  jobId: string
  stageNumber: number
  userId: string
  userRole: string
  checklistData?: unknown
  notes?: string
}) {
  const { jobId, stageNumber, userId, userRole, checklistData, notes } = params

  const stages = await db.workflowStage.findMany({
    where: { jobId },
    orderBy: { stageNumber: 'asc' },
  })
  if (!stages.length) {
    await initializeWorkflowForJob(jobId)
    return completeWorkflowStage(params)
  }

  const current = stages.find((s) => s.stageNumber === stageNumber)
  if (!current) throw new Error('Stage not found')

  if (current.responsibleRole && current.responsibleRole !== userRole) {
    throw new Error('You are not authorised to complete this stage')
  }
  if (current.status === 'completed') return stages

  await db.$transaction(async (tx) => {
    const updateData: any = {
      status: 'completed',
      actualEnd: new Date(),
      assignedTo: userId,
    }
    if (checklistData !== undefined) updateData.checklistData = checklistData as any
    if (notes !== undefined) updateData.notes = notes

    await tx.workflowStage.update({
      where: { id: current.id },
      data: updateData,
    })

    let nextStageNumber = stageNumber + 1

    // Auto-skip embossing stage in conditional routing flows.
    if (stageNumber === 13) {
      const checklist = (checklistData && typeof checklistData === 'object')
        ? (checklistData as { postPressRouting?: { embossing?: boolean }; embossing?: boolean })
        : null
      const embossRequired = checklist?.postPressRouting?.embossing ?? checklist?.embossing
      if (embossRequired === false) {
        const embossStage = stages.find((s) => s.stageNumber === 14)
        if (embossStage) {
          await tx.workflowStage.update({
            where: { id: embossStage.id },
            data: {
              status: 'not_applicable',
              notes: 'Auto-skipped: Embossing not required for this product',
              actualStart: new Date(),
              actualEnd: new Date(),
            },
          })
        }
        nextStageNumber = 15
      }
    }

    const next = stages.find((s) => s.stageNumber === nextStageNumber)
    if (next && next.status === 'pending') {
      await tx.workflowStage.update({
        where: { id: next.id },
        data: { status: 'in_progress', actualStart: new Date() },
      })
    }
  })

  return getWorkflowForJob(jobId)
}

