-- COSTING COATING FACTORS — factors 5, 4, 2.5, 1 and 0.5 join the cost sheet's 6, 3 and 2 as coating
-- buttons (owner's ask). Written 2026-10-30.
--
-- APPLIED to colour-impressions-prod 2026-10-31 as the named migration `costing_coating_factors`
-- (owner's go-ahead: "Yes, ship it").
--
-- Changes only the untouched starting list, so a replay does nothing and a list already edited on the
-- Rates tab (names, deletions) stays as it is.
UPDATE costing_settings
SET coatings = '[{"factor": 6, "name": ""}, {"factor": 5, "name": ""}, {"factor": 4, "name": ""}, {"factor": 3, "name": ""}, {"factor": 2.5, "name": ""}, {"factor": 2, "name": ""}, {"factor": 1, "name": ""}, {"factor": 0.5, "name": ""}]',
    updated_at = now()
WHERE id = 1
  AND coatings = '[{"factor": 6, "name": ""}, {"factor": 3, "name": ""}, {"factor": 2, "name": ""}]'::jsonb;
