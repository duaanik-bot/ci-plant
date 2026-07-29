-- MD joins the plant head as an extra-sheet approver.
--
-- 0007 seeded the grants once, guarded on "nobody holds this yet", so it can
-- never revisit a live database — which is correct for a seed and useless for a
-- decision taken afterwards. This states the decision plainly: MD and the Plant
-- login (the plant head's seat) hold BOTH grants; every other login keeps
-- neither. Only ever ADDS, so a grant someone deliberately switched off in
-- Masters → Users is not revived by a replay.
UPDATE users SET xs_approver = 1, is_management = 1
WHERE email IN ('md@motionci.com', 'plant@motionci.com');
