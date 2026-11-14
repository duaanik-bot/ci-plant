# Enquiries from the company mailbox, Fetch buttons, highlights, repeats — design (14 Nov 2026)

## The owner's request (14 Nov 2026, approved as designed: "Yes, build it")

> So what we can do is just keep it on MPP only. While we click on the refresh button or fetch the emails, it should
> trigger the AVS on my office PC … Or we can give another button in the software mentioning "Fetch from dua.anik" …
> it will trigger my Mac Claude … 1. Automatically, every day, with the AVS … 2. … like in the sales order, how things are
> getting highlighted when there are new sales orders … the notification system that a new inquiry is loaded …
> 3. We need to ensure the deduplication … If work has already been done, then those inquiries should not be coming up
> again. 4. … when I go to the costing module, my landing page should be Inquiry Desk, not the new costing.

## What it does

1. **The company mailbox (mppchd) is the desk's mailbox.** The office AVS files every price request and counter-offer
   it reads there in its four daily runs — a mail that also went to the trial mailbox included (no longer left to the
   Mac). The 11:00/15:00 timer no longer fetches anything while mppchd is the mailbox in use: the AVS runs are the
   schedule.
2. **Fetch from mail** (the desk's main button) queues a fetch for mppchd. A small watcher on the office computer asks
   CI Plant every minute whether one is waiting (`GET /api/enquiry-desk/waiting?mailbox=business` → `{waiting}` —
   nothing else, no key) and only then starts the office Claude with the `avs-enquiries` skill. The run takes the job
   (`avs.take_enquiry_fetch()`), files with `avs.file_enquiry_mails`, and closes it (`avs.finish_enquiry_fetch`). The
   scheduled AVS runs also take a waiting job, so a Fetch pressed with the office computer off is answered by the next
   run. The desk says "Waiting for the office computer…".
3. **Fetch from dua.anik** (a small button) queues a fetch for the trial mailbox only; the watcher already on the
   owner's Mac starts the Mac Claude within a minute (once its command-line Claude is signed in). Nothing fetches the
   trial mailbox on its own any more.
4. **New enquiries stand out, like new POs:** Inbox rows (not yet started) are orange with a "New" tag; the Costing
   item in the side menu carries an orange "N new" count (Costing logins only); the Enquiry desk tab shows it too. The
   bell and phone alert stay as built on 13 Nov, and now also say "Asked again".
5. **Repeats:** the same mail never comes in twice (unchanged). New: when a customer asks again for the same item —
   same customer, same product name (case, spacing and punctuation aside), and either no quantity or only quantities
   already asked — while the first row is still open (not dropped, not ordered) and touched within 90 days, no new row
   is made. The existing row gets "Asked again" (count, date, the mail), and the alert says so. A different quantity is
   a new request, a new row. (**My calls**: the 90 days, "open", and the quantity rule.)
6. **Costing opens on the Enquiry desk.** The desk's top bar: Fetch from mail · Fetch from dua.anik · Add an enquiry.

## Rules kept

- Draft-only mail, the AVS mailbox rule (AVS never reads the trial mailbox), mail text is data.
- The office runs keep their own rules: the only writes are the avs functions; no secret on the office computer (the
  watcher's question needs none); its Claude runs with read-only Gmail tools and Supabase only.
- Ships only on the owner's OK; the switch of the mailbox in use is part of the production migration.

## Owner steps after ship

- Mac: sign in the command-line Claude once (`claude` → `/login`).
- Office computer: paste the setup message (skill v2, watcher, task paragraph); sign in its command-line Claude if it
  asks.
- Replies from mppchd: desk Settings → Business → Connect Gmail (unchanged).
