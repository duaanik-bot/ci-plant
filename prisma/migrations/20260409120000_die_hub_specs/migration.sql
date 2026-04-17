-- Die Hub: dimensions, pasting, make, DOM for similar-die matching and lifecycle.

ALTER TABLE "dyes" ADD COLUMN "dim_length_mm" DECIMAL(12,4);
ALTER TABLE "dyes" ADD COLUMN "dim_width_mm" DECIMAL(12,4);
ALTER TABLE "dyes" ADD COLUMN "dim_height_mm" DECIMAL(12,4);
ALTER TABLE "dyes" ADD COLUMN "pasting_type" VARCHAR(64);
ALTER TABLE "dyes" ADD COLUMN "die_make" VARCHAR(16) NOT NULL DEFAULT 'local';
ALTER TABLE "dyes" ADD COLUMN "date_of_manufacturing" TIMESTAMP(3);
