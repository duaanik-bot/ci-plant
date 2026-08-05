-- Printing colour composition and printing PROCESS — two independent axes.
--
-- colour_type (already present) says what the colour build IS: CMYK, Pantone,
-- or CMYK + Pantone. print_process says how it is LAID DOWN: Offset, Metallic,
-- or Offset + Metallic. They are deliberately NOT one field. A Pantone spot
-- colour is not a metallic ink — Pantone 871 C looks gold and prints on a
-- conventional offset unit — and folding the two together is what put Pantone
-- and metallic jobs into the same bucket on the floor. Metallic is true only
-- because someone chose a metallic ink, never because a Pantone code exists.
--
-- Every count is nullable and NOTHING is backfilled: 300+ live products carry
-- only colour_type + colors, and inferring counts for them would be guessing.
-- server/src/print-colour.js and client/src/lib/printColour.js derive a
-- sensible count from colour_type + colors when these are NULL, so an
-- untouched product still reads "CMYK — 4 colours" and raises no warnings;
-- only a typed value is ever presented as exact.
--
-- The colors column keeps its existing meaning: the TOTAL number of printing
-- colours, i.e. cmyk_colours + pantone_colours + metallic_colours.
--
-- Additive only — every column is nullable with no rewrite of existing rows,
-- so this is safe to apply while the plant is running.

ALTER TABLE products ADD COLUMN IF NOT EXISTS print_process TEXT DEFAULT 'Offset';
ALTER TABLE products ADD COLUMN IF NOT EXISTS cmyk_colours INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pantone_colours INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pantone_codes TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS metallic_colours INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS metallic_details TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS print_instructions TEXT;
