-- Reserved rack slot chosen from Universal Tooling Hub (stock triage)
ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "reserved_rack_slot" TEXT;
