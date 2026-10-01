-- How serious each AVS point to clear is (owner's request, 1 Oct 2026; runbook rule 24).
-- CRITICAL: could put a wrong or unsafe pack on the market (REJECT).
-- MAJOR: print or material does not meet the PO / approved artwork, or a key fact
--        could not be verified (HOLD).
-- MINOR: records and housekeeping, nothing wrong on the carton itself (HOLD).
-- Claude writes it with each new point; points filed before this column get it
-- here: REJECT -> CRITICAL, the R- points below (read one by one on 1 Oct 2026)
-- -> MAJOR, every other HOLD point -> MAJOR for D-, MINOR for R-.
ALTER TABLE avs.problems ADD COLUMN IF NOT EXISTS severity text
  CHECK (severity IS NULL OR severity IN ('CRITICAL', 'MAJOR', 'MINOR'));

UPDATE avs.problems SET severity = 'CRITICAL' WHERE severity IS NULL AND result = 'REJECT';

UPDATE avs.problems p SET severity = 'MAJOR'
  FROM avs.latest_reports l, (VALUES
    ('AVS-2026-0016', 'R-3'),
    ('AVS-2026-0016', 'R-5'),
    ('AVS-2026-0015', 'R-1'),
    ('AVS-2026-0014', 'R-1'),
    ('AVS-2026-0013', 'R-1'),
    ('AVS-2026-0013', 'R-2'),
    ('AVS-2026-0012', 'R-1'),
    ('AVS-2026-0011', 'R-1'),
    ('AVS-2026-0010', 'R-1'),
    ('AVS-2026-0009', 'R-2'),
    ('AVS-2026-0007', 'R-1'),
    ('AVS-2026-0006', 'R-1'),
    ('AVS-2026-0006', 'R-5'),
    ('AVS-2026-0005', 'R-1'),
    ('AVS-2026-0005', 'R-2'),
    ('AVS-2026-0005', 'R-3'),
    ('AVS-2026-0005', 'R-6'),
    ('AVS-2026-0004', 'R-1'),
    ('AVS-2026-0004', 'R-2'),
    ('AVS-2026-0004', 'R-6'),
    ('AVS-2026-0003', 'R-1'),
    ('AVS-2026-0003', 'R-2'),
    ('AVS-2026-0003', 'R-6'),
    ('AVS-2026-0003', 'R-8'),
    ('AVS-2026-0002', 'R-10'),
    ('AVS-2026-0002', 'R-11'),
    ('AVS-2026-0002', 'R-2'),
    ('AVS-2026-0002', 'R-3'),
    ('AVS-2026-0002', 'R-5'),
    ('AVS-2026-0002', 'R-9'),
    ('AVS-2026-0001', 'R-8')) AS m(report_no, ref)
 WHERE p.report_id = l.id AND l.report_no = m.report_no AND p.ref = m.ref
   AND p.severity IS NULL AND p.result = 'HOLD';

UPDATE avs.problems SET severity = CASE WHEN ref LIKE 'D-%' THEN 'MAJOR' ELSE 'MINOR' END
 WHERE severity IS NULL AND result = 'HOLD';
