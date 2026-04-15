-- Die / emboss hub Kanban: reuse analytics + undo staging
ALTER TABLE "dyes" ADD COLUMN "reuse_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "dyes" ADD COLUMN "hub_previous_custody" VARCHAR(32);

ALTER TABLE "emboss_blocks" ADD COLUMN "reuse_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "emboss_blocks" ADD COLUMN "hub_previous_custody" VARCHAR(32);
