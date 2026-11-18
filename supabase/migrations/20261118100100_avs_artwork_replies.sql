-- The office AVS also files clients' replies to our approval mails, and proofs the designer sent by hand (owner,
-- 17 Nov 2026; design plans/2026-11-17-artwork-workflow-design.md §8, §9a). PRODUCTION ONLY, like the other avs
-- migrations; a test runs it after 20261115100100_avs_artwork_intake.sql.
--
--   kind 'reply'          a client's answer to a proof: items [{ "proof_nos": [...], "verdict": "approval" | "changes" |
--                         "unclear", "remarks": "…" }]
--   kind 'proof_by_hand'  mppchd replied in the client's thread with a proof PDF made by hand: items [{ "files": [...] }]
do $$
begin
  alter table avs.artwork_intake drop constraint if exists artwork_intake_kind_check;
  alter table avs.artwork_intake add constraint artwork_intake_kind_check
    check (kind in ('artwork', 'to_sort', 'reply', 'proof_by_hand'));
end $$;
