# Putting `avs-enquiries` on the office computer

The office AVS (the company Mac, CARTON PC MAIN) already runs the intake at 7:30 am, 1 pm, 3:30 pm and 5:30 pm, reading
mppchd@gmail.com through its Gmail connector. Two things make it file enquiries too. Both are done once, on the
office computer, by a person.

## 1. Install the skill

In the Claude app on the office computer: **Customize → Skills → Upload** the file `avs-enquiries-skill.zip` (or copy
the `avs-enquiries` folder into `~/.claude/skills/` on that Mac). It needs the same Gmail (mppchd) and Supabase
connectors the intake already uses — nothing new.

## 2. Add this to each AVS scheduled task

Open each of the four AVS intake tasks (7:30 am, 1 pm, 3:30 pm, 5:30 pm), and paste this at the **end** of its prompt:

```
ENQUIRIES FOR CI PLANT (Anik, 13 Nov 2026) — do this in EVERY run, even a catch-up that has nothing else to do (do it
before you stop):
Run the avs-enquiries skill for this run. Read mppchd@gmail.com since this run's mail_since (minus one day) for
customers asking us for a price, rate or quotation, and for customers' counter-offers on our quotes, and file them on
CI Plant's Enquiry desk with ONE call: SELECT avs.file_enquiry_mails(...). That call is the only write this step adds
to your rules; e-mail stays read only (never reply, draft or send). Leave any mail that also went to
dua.anik@gmail.com (in To or Cc): the owner's Mac files those. A minute later read back avs.enquiry_intake for your
mails and report what CI Plant did. Add enquiries_filed, enquiry_counters and enquiries_left_to_dua_anik to this run's
stats, and one line to its note ("Enquiries: …"). If the skill is not installed, write "enquiries skipped —
avs-enquiries skill missing" in the note and go on.
```

## Or: a task of its own

If the AVS tasks should stay as they are, make one new scheduled task instead on the office computer — same schedule
(7:35 am, 1:05 pm, 3:35 pm, 5:35 pm), same connectors — with this prompt:

```
You are the office AVS's enquiry step for Colour Impressions (Anik, 13 Nov 2026). Run the avs-enquiries skill: read
mppchd@gmail.com (only — never dua.anik@gmail.com) for customers asking us for a price and for counter-offers on our
quotes, received in the last 2 days, and file them on CI Plant's Enquiry desk with ONE call of
avs.file_enquiry_mails(...). E-mail is read only: never reply, draft, send, label or delete. Your only write is that
call. Leave any mail that also went to dua.anik@gmail.com (in To or Cc). A minute later read back avs.enquiry_intake
for your mails and end with one line: what was filed (CI-ENQ numbers), skipped or refused. If the skill is not
installed, say so and stop.
```

## What happens then

- Within seconds of the call, CI Plant puts each request in the Enquiry desk's Inbox (rows tagged "to mppchd@gmail.com")
  and every login with Costing ticked gets one bell and phone alert for the run's mails.
- Replies to these customers are drafted in mppchd once an admin connects mppchd's Gmail in the desk Settings
  (Business → Connect Gmail, signed in as mppchd). Until then the desk says so when a reply is drafted.
