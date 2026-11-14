# Putting `avs-enquiries` on the office computer (v2, 14 Nov 2026)

The office AVS (the company Mac, CARTON PC MAIN) runs the intake at 7:30 am, 1 pm, 3:30 pm and 5:30 pm, reading
mppchd@gmail.com through its Gmail connector. Since 14 Nov the company mailbox is the Enquiry desk's only mailbox, and
the desk's **Fetch from mail** button starts this computer within a minute when it is a Mac with the watcher (section 3).
The office computer is Windows (14 Nov 2026), so there a Fetch from mail is started at once by the company account's
cloud routine, linked in the desk's Settings (`skills/enquiry-desk/robot/cloud-routine.md`), and otherwise waits for
the next run. Three things, done once by a person (or by the office Claude from the setup message
`office-pc-avs-enquiries-update-2.txt`):

## 1. The skill

Install `SKILL.md` as the skill `avs-enquiries` (Customize → Skills → Upload, or `~/.claude/skills/avs-enquiries/`).

## 2. The paragraph in each AVS scheduled task

Replace the 13 Nov "ENQUIRIES FOR CI PLANT" paragraph at the end of each of the four AVS intake tasks with:

```
ENQUIRIES FOR CI PLANT (Anik, 13–14 Nov 2026) — do this in EVERY run, even a catch-up that has nothing else to do (do
it before you stop):
Run the avs-enquiries skill for this run. It takes a waiting "Fetch from mail" first (avs.take_enquiry_fetch), reads
mppchd@gmail.com since this run's mail_since (minus one day) for every customer asking us for a price, rate or
quotation and for counter-offers on our quotes — also mails that went to other addresses of ours too — files them with
ONE call of avs.file_enquiry_mails, and closes the Fetch (avs.finish_enquiry_fetch). Those three avs calls are the only
writes this step adds to your rules; e-mail stays read only (never reply, draft or send). A minute later read back
avs.enquiry_intake for your mails. Add enquiries_filed, enquiry_counters and enquiries_asked_again to this run's stats,
and one line to its note ("Enquiries: …"). If the skill is not installed, write "enquiries skipped — avs-enquiries
skill missing" in the note and go on.
```

## 3. The watcher (a Mac only: answers "Fetch from mail" within a minute)

In Terminal on the office computer:

    curl -fsSL https://motionci.in/office/avs-enquiry-watch/install.sh | bash

It installs `~/.config/ci-plant/avs-enquiry-watch/` (the watcher, its run prompt, and a guard that lets the run only
read the company mailbox and file through the avs functions) and a launchd job that asks CI Plant every minute whether
a Fetch is waiting — a yes or no, with no key. Claude starts only on a yes. The command line Claude must be signed in
once on that computer (in Terminal: `claude auth login` — `/login` works only inside Claude); the installer says
whether it is.

Its log: `~/.config/ci-plant/avs-enquiry-watch/watch.log`. To stop it:
`launchctl unload -w ~/Library/LaunchAgents/in.motionci.avs-enquiry-watch.plist`.
