-- The company mailbox is the Enquiry desk's mailbox (owner, 14 Nov 2026: "just keep it on MPP only"). PRODUCTION ONLY:
-- a data switch, never replayed by init(). The trial mailbox stays, fetched only on "Fetch from dua.anik".
-- Two statements, the old one off first: enquiry_mailboxes_one_in_use allows one mailbox in use at a time.
UPDATE enquiry_mailboxes SET in_use = false, updated_at = now(), updated_by_name = 'Anik Dua (MD) via Claude'
 WHERE in_use AND key <> 'business';
UPDATE enquiry_mailboxes SET in_use = true, updated_at = now(), updated_by_name = 'Anik Dua (MD) via Claude'
 WHERE key = 'business' AND NOT in_use;
