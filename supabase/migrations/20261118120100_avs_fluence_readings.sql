-- The office AVS also files what it read from Fluence's mails — a kit's prescription and MRPs from its artwork, an MRP
-- sheet, a PO's MRPs — as intake kind 'fluence' (owner, 18 Nov 2026). PRODUCTION ONLY, like the other avs migrations; a
-- test runs it after 20261118100100_avs_artwork_replies.sql.
do $$
begin
  alter table avs.artwork_intake drop constraint if exists artwork_intake_kind_check;
  alter table avs.artwork_intake add constraint artwork_intake_kind_check
    check (kind in ('artwork', 'to_sort', 'reply', 'proof_by_hand', 'fluence'));
end $$;
