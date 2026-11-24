# Finance — Cash & Bank, with receipts and payments that settle bills — Design

**Status:** APPROVED by Anik on 2026-11-20 ("Approve design"). Written the same day.
- **Not committed.** This session works under the "nothing ships" agreement in the project's `CLAUDE.md`. The file stays on disk, on branch `feat/finance-cash-bank` (worktree `ci-erp-finance-cash`, cut from origin/main 89d40a97), until Anik says otherwise.
- **Builder check done 2026-11-20.** Its answered and minor points are folded in. Anik answered its two remaining questions the same day (§16).

**Builds on:** `docs/superpowers/specs/2026-10-16-finance-ledger-core-design.md` (Finance sub-project 1, "SP1", live since 2026-10-27).
- SP1's principles, hard stops (H1–H11), approval rules and lock order bind this design.
- References like "SP1 §7.2" point into that spec.

**Where this fits in the Finance programme:**
- It is sub-project 4, "Cash & bank", without bank reconciliation.
- It brings forward the bill-wise core of sub-project 5.
- It adds the payroll half of "postings from other modules".
- The **invoice feed** (sub-project 2: ERP invoices and purchase bills posted into Finance) is the next design. This design defines the interface the feed plugs into (§6.8).

---

## 1. Why this exists

**What Anik asked for** (2026-11-20, his words, lightly cleaned):
- "We have some system for handling the cash in Pureflix, where we have just created a cash account and then we are able to manage that and also manage the accounts. The same way, we need to put that into Colour Impressions as well, where we should be able to do inter-account entries: the cash in and out, cash to labour, dedicating it to the name of the person. We should also be able to view the cash ledger, and things should be quite easier in that finance module."
- "While taking the receipts or making payments, auto select the invoice, no hard blocker, ask me for invoice selection or auto, so system may auto adjust the amount."
- "Give me options to pay [the cash holder] cash, and adjust the opening balance."

**Why it's needed:**
- **Finance has the engine but no easy front.** It already does double entry, approvals, month locks, reversal instead of deletion, and the Tally opening. Its only entry screen, though, is the generic voucher form.
- **The ERP's own Accounts books block receipts.** They have been live since 2026-10-05. They take one receipt per invoice and refuse any amount above that invoice's balance, which is the "hard blocker" Anik means. They are barely used (§1.2).

**What success looks like:** from 1 January 2027 the accountant records every rupee into and out of cash and bank on one screen, quickly.
- Receipts and payments settle bills, automatically or by pick.
- Staff money recorded in HR arrives in the books by itself.
- The books stay right.

### 1.1 Decisions Anik made (2026-11-20)
1. **Approach A: all in Finance** (§4).
2. **The labourers paid in cash are on the HR payroll.** Staff money is entered only in HR, and Finance picks it up (§7).
3. **The accountant keeps the cash, hands it out and types the entries, at a desk.** The screens are desktop and keyboard-first, with no phone flow.
4. **All cash is handled as one.** The office gives cash to a person who distributes it; Pureflix has the same role. Each such person (a "holder") gets a cash account (§5.4). There is one cash box, and it is Colour Impressions': the DP book gets no cash accounts, and Darbi's money moves through its own banks (§5.4).
5. **Every receipt and payment asks: pick the bills, or Auto.** Nothing is refused for not matching (§6).
6. **Dummy entries are fine for trying it:** "It is the new module, so no one has ever handled it. You can put the dummy entries."
7. **The proposed options for giving a holder cash, and for opening balances, stand.** He was told they would be taken unless he changed them:
   - transfers from office cash or a bank, a top-up to a set float, the return of leftover cash, and holders offered as a "paid from" choice (§5.3);
   - a holder's opening float recorded as a transfer on 1 January;
   - an opening lump with no bill break-up settled first by Auto;
   - an opening correction that changes only the wrong figures, with his approval (§9).

**Proposals he saw and did not object to.** These are treated as agreed, and listed here so he can check them:
- HR's cash payouts say which cash they came from: the office or a holder (§7.3).
- Per-person detail stays in HR, and the books show only counts and totals (§7.4).
- Vendor payments get their own number series (§11, item 6).

### 1.2 What exists today
Read 2026-11-20 at origin/main 89d40a97, plus read-only counts on the live database.

**Finance (SP1):**
- Books CI and DP exist, each beginning 2027-01-01. There are no vouchers yet.
- Seeded approval rules: journal, opening and reversal are `always`; payment and contra are `above_limit` ₹1,00,000; receipt, sales and purchase are `never`.
- Every voucher line already carries `bill_ref`, `bill_date` and `due_date`.
- Vouchers carry `source_type`, `source_id` and `source_fingerprint`, with at most one live posting per source (H8).
- Party ledgers carry `party_type` + `party_id`: an ERP customer or vendor id, with no foreign key.
- The Opening voucher (dated 2026-12-31) is built from Tally, with bill-wise lines for parties. Its import maps one Tally row to one Finance ledger.

**The ERP's Accounts books:**
- **Receipts:** Invoices page → Record Payment, `POST /payments`, numbered `CI-RCPT-`. A receipt goes against one invoice or on account. Above the invoice's balance it answers 409 "Payment exceeds balance".
- **Vendor payments:** `POST /vendor-payments`, numbered `CI-PAY-`, with the same rule against one bill.
- **Accounts page tabs:** Payables, Purchase Bills, Cash & Bank Book, Party Ledger. Their GET routes check no role, so any logged-in user can read them.
- **Live use:** nearly every invoice shows as open, and hardly any receipts are recorded, because receipts are entered in Tally; so the ERP's open list is not a true list of what customers owe. There are no purchase bills and no vendor payments.

**HR & Payroll:**
- Money moves through several HR screens:
  - **Pay staff** gives one advance or one loan. A loan stores `paid_via`; an advance keeps it only in its note text.
  - **Loans & Advances** has its own "Give advance" (it records no account at all), "New loan" (a free-text "paid out via") and loan prepayments (money coming back, with no account).
  - **Advance sheets** (`CI-ADV-`) store `paid_via`. None exist yet.
  - **The month's payroll sheet** can carry advances handed out during the month; HR posts them when the month is finalised.
  - **Mark paid** creates `hr.payment_batches` rows, numbered `CI-PAY-`. Batches already exist, most of them on the cash channel. A single line marked paid from the line drawer creates no batch.
- Pay channels are CASH, COLOUR, DARBI and DARBI SPECIAL, each of kind cash or bank. No bank names are stored.
- The current staff are paid partly in cash and partly by bank, some of them on the DARBI channel. All carry firm COLOUR, except a few with no firm set.
- The payroll's final pay is gross − deductions − an amount "paid separately" (the salary workbook's column headed with the MD's name), which is paid outside the bank and cash runs.
- **The Accounts login holds HR level `accounts`.**
  - It can enter, submit, approve, finalise and un-finalise a month, and mark salary paid.
  - Only approving each person's payment needs an HR approver (today the MD), and a line can be marked paid only once approved.
  - Some people are hidden from it, and all of them are paid by bank. HR leaves hidden people out of every total that login sees, so that nothing about them can be worked out from a difference, and leaves their payouts for the MD.

**A number clash:** HR mints `CI-PAY-` numbers from `hr.payment_batches`, and the ERP mints `CI-PAY-` from `vendor_payments`, on separate counters. The first vendor payment would therefore repeat CI-PAY-0001.

---

## 2. Goals, non-goals, anti-goals

**Goals**
- **G1. One Cash & Bank screen per book.** It shows:
  - every cash and bank account, with its live balance;
  - Receive, Pay and Transfer;
  - each account's book, with a running balance;
  - export and print.
- **G2. Receipts and payments settle bills.** Every time, the screen asks Auto or Pick. Nothing is refused for not matching:
  - extra money stays on account;
  - short money leaves a bill part-paid;
  - the adjustment can be redone later.
- **G3. Cash holders.** Each has a float, given and returned by transfer, with a top-up and a cash count.
- **G4. Staff money from HR.** What HR records reaches the books by itself, exactly once, as totals.
- **G5. Opening corrections.** A wrong opening figure can be corrected without rebuilding the Opening.
- **G6. One door.** From 1 January 2027, receipts and payments are entered in Finance only.
- **G7. Speed.** Fast at a keyboard, for an accountant used to Tally.

**Non-goals (not in this design)**
- **The invoice feed** (ERP invoices and purchase bills into Finance) is the next design. Until it lands, receipts adjust against the opening's bills, or wait on account.
- **Bank work:** reconciliation, statement import and cheque registers (the rest of sub-project 4).
- **Later sub-projects (5 and 6):**
  - GST input on expenses;
  - credit and debit notes;
  - credit limits;
  - customer statements;
  - TDS returns and sections.

  The "TDS deducted" field in §5.1 and §5.2 is only an amount posted to a chosen ledger.
- **Phone screens and Hindi.**
- **Changing Anik's existing approval rules.** HR entries count approvals already given in HR, and otherwise follow the seeded rules. One new rule key is added, for cash-count differences (§8).
- **A practice book on motionci.in.** It was offered to Anik, and is not included unless he asks (§13).
- **Showing Finance's receipts as "paid" on the ERP's Invoices page.** The invoice-feed design decides this.
- **Inter-company money.** Moving money between the two companies' books is out of scope, except for the DARBI salary channel (§7.3). Anik: all cash is "handled under one", in one box that is CI's (§5.4).

**Anti-goals (each of these is a failure, even if everything else works)**
- **The same money entered twice:** an ERP receipt plus a Finance receipt, or an HR advance plus a Finance payment.
- **Leaked staff data:** any worker's name, code or individual pay in Finance; or anything HR hides from a login reaching that login through Finance. The one exception, accepted by Anik on 2026-11-20: the combined pay of the people hidden in HR can be worked out from the books' payroll totals (§7.4).
- **A refusal for not matching:** a receipt or payment refused because it doesn't match bills.
- **Figures that don't add up:** bill-wise figures that differ from the party's ledger balance. Pureflix's invoice balances can drift from its ledger; that must not happen here.
- **Dummy entries in the real books:** posted entries can only be reversed, never deleted, so they would stay forever.
- **The plant blocked by a Finance rule** (SP1 principle 1).

---

## 3. Constraints
- **SP1's six principles hold** (SP1 §2). This design's changes outside Finance are listed in full in §11, as SP1 §12 did.
- **"No hard blocker" means bill matching.**
  - The books' own hard stops (SP1 §7.2, H1–H11) stay exactly as they are.
  - New behaviour warns. It never refuses for the sake of convenience.
- **The HR privacy wall:**
  - Finance reads HR only in server code.
  - It takes counts and totals, and never stores or shows a name, a code, or a per-person amount.
  - Notifications carry no amounts, as HR's rule already requires.
- **Lock order** (SP1 §6.2, §7.4): series lock → voucher `FOR UPDATE` → months `FOR SHARE` in id order → ledgers `FOR SHARE`.
  - Anything new takes its locks at a fixed place in that order.
  - Nothing takes a share lock and then asks for an update lock on the same row (§6.6).
- **Vercel Hobby:** responses are capped at 4.5 MB and functions at 30 s, and there is a history of refresh storms.
  - Lists are windowed, to the current month by default.
  - Counts come from count-only reads (SP1 R71, R72).
- **Public repository:** no real names, codes or pay figures, and no accountant login email, in code, fixtures or docs (SP1 R68, and the payroll leak-scan rule). This document names no worker: "holder" means any person the office gives cash to.
- **Money, dates and "today":**
  - Money is integer paise in code and NUMERIC(18,2) in the database.
  - Dates are 'YYYY-MM-DD' TEXT.
  - "Today" comes from `plantDateStr()`.
- **No commits or deploys** unless Anik says so in that session. The production migration is applied by hand, as a named migration, after a dry run.

---

## 4. Approaches (Anik chose A on 2026-11-20)

**A. All in Finance (chosen)**
- Finance gets a Cash & Bank screen.
- Every entry is a normal Finance receipt, payment or contra, so approvals, locks, reversal and the audit log all apply.
- Bill-wise adjustment lives in Finance, and HR payouts post into Finance.
- From 1 January, the ERP's Record Payment and vendor-payment buttons open Finance.
- **Cost:** real entries start only when the books open on 1 January, and it is the bigger build.

**B. Upgrade the ERP's Accounts screens now, and have Finance copy them from January (rejected)**
- **Two money records with different rules.** The ERP's screens delete outright, have no approvals or locks, and store money as floating point. Finance would have to chase every later edit and delete.
- **Too visible.** Every ERP login can read those screens, so holder floats and salary payouts would be visible across the plant.
- **More total work.** Most of A would still be needed later.

**C. Shortcuts on Finance's existing voucher form (dropped)**
- It has no Auto/Pick, and it is not easier, which is the point of the request.

---

## 5. The Cash & Bank screen

**The page:** `/finance/cash`, the first item of the Finance nav group, labelled "Cash & Bank". It follows the conventions of every Finance page:
- the book switch;
- `PageHeader → KpiRow → Tabs → DataTable`;
- realtime refresh on the Finance tables;
- capability-based hiding. The hiding is cosmetic; the server refuses regardless.

**Who may do what** (SP1 capabilities):
- **Viewer** sees the page.
- **Accountant or Approver** enters Receive, Pay, Transfer, a count, or a redo. An Accountant may also add a holder: a ledger under an existing group, as SP1 §8.1 already allows.
- **Approver** approves.
- **Admin** maps HR pay channels (§7.3).

```
Finance › Cash & Bank                                   [ Colour Impressions ▾ ]
┌────────────────┬────────────────┬────────────────┬────────────────┐
│ Office cash    │ Holder A       │ Bank – current │ Bank – CC      │
│ ₹1,70,000      │ holds ₹10,000  │ ₹15,00,000     │ –₹3,00,000     │
│ counted 12 Jan │ float ₹50,000  │                │                │
└────────────────┴────────────────┴────────────────┴────────────────┘
[ Receive  R ]  [ Pay  P ]  [ Transfer  T ]  [ Count cash ]     Unadjusted money: ₹45,000 · 3
HR entries waiting: 0 · Exceptions: 0                           Staff advances vs HR: matches

Office cash · January 2027 ▾                                      Export ▾   Print
Date    Voucher          Particulars                              In        Out     Balance
01 Jan  CI-CV-2627-0001  To Holder A · float                              10,000  1,90,000
05 Jan  CI-RV-2627-0003  Acme Pharma · Auto: 3 bills, ₹0 on acc  80,000            2,70,000
07 Jan  CI-PV-2627-0004  Salary Dec · cash · CI-PAY-0041 · 9 ppl        1,00,000  1,70,000
```

**Tiles**
- There is one tile per active bank or cash ledger: any ledger whose group is, or descends from, Bank Accounts, Cash-in-Hand or Bank OD A/c (SP1 §6.4).
- Each tile shows the balance as at today, from posted lines.
- A holder's tile shows what the holder holds, the set float if there is one, and the date of the last count.
- Clicking a tile shows that account's book below.

**The book**
- It lists the selected account's posted lines in a date window. The default window is the current month.
- It shows the opening and closing balances and a running balance. No column is sortable (SP1 §10).
- "Particulars" names the other side. For a party it also shows the adjustment, e.g. "Auto: 3 bills, ₹0 on account".
- Export is Excel or PDF through `ExportMenu`; print follows the ERP's A4 pattern.
- Vouchers waiting for approval show greyed below the posted lines, with their own subtotal. A pending transfer is visible, but it is not in the balance.

**Header counts**
- Unadjusted money: party credits that still have money on account.
- HR entries waiting and HR exceptions (§7.7).
- The staff-advances control check (§7.5).

### 5.1 Receive (R)
**Fields:**
- **Date:** defaults to the last one used.
- **Into:** a bank or cash account, holders included.
- **From:** type-to-search, customers first, then any ledger.
- **Amount.**
- **TDS deducted:** customers only, optional.
- **Reference and narration.**

**Adjusting bills.** For a customer, the form asks every time: **[Auto – oldest first] [I'll pick]** (§6.3, §6.4).
- Neither is pre-chosen. Auto comes first in the tab order.
- Before saving, a preview shows what each bill gets and what stays on account.

```
Receive                                            CI · 05 Jan 2027
Into  [ Office cash      ]     From [ Acme Pharma · customer      ]
Amount [ 80,000.00 ]   TDS deducted [ 1,600.00 ]   Ref [ NEFT 4471 ]
Adjust against bills:  [ Auto – oldest first ]   [ I'll pick ]
  Opening balance                31 Dec   due 20,000  →  20,000 settled
  Opening bill 0091              02 Dec   due 35,000  →  35,000 settled
  Opening bill 0104              18 Dec   due 40,000  →  26,600 part · 13,400 left
  On account                                           →       0
                                                [ Save  Ctrl+Enter ]
```

**Posting:** one `receipt` voucher.
- **Dr** the into-account, for the amount.
- **Dr** the TDS-receivable ledger, for the TDS, if any.
- **Cr** the customer, for the amount plus the TDS.

The customer's credit line carries the allocations (§6).

**From any other ledger** (capital, a loan, miscellaneous income): Dr the account and Cr that ledger. No bills are involved.

**Approval:** the receipt rule, which is `never`, as seeded.

### 5.2 Pay (P)
**Fields:**
- **Date.**
- **From:** a bank or cash account, holders included.
- **To:** a vendor, an expense ledger, or any other ledger.
- **Amount.**
- **TDS deducted:** vendors only, optional.
- **Reference:** their bill number.
- **Narration.**

**Adjusting bills.** For a vendor, the form offers the same **Auto / I'll pick** against the vendor's open bills.

**Posting:** one `payment` voucher.
- **Dr** the vendor, for the amount plus the TDS.
- **Cr** the from-account, for the amount.
- **Cr** the TDS-payable ledger, for the TDS.

**To an expense or any other ledger:** Dr that ledger and Cr the account.

**Approval:** the payment rule. Above ₹1,00,000 it waits for an Approver, as seeded.

**Staff are not paid here.**
- The "to" picker leaves out the staff ledgers (§7.2).
- The form says "Staff advances and salaries are paid in HR". For a login with HR access, that line links to HR.

### 5.3 Transfer (T)
**What it is:** "from" and "to" are two bank or cash accounts of the book.

**Posting:** one `contra` voucher.

**Approval:** the contra rule. Above ₹1,00,000 it waits, as seeded. So a ₹2,50,000 float given to a holder waits for the MD. Anik was told this and kept the rule.

**Shortcuts on a holder's tile.** All three are plain transfers:
- **Give cash:** from office cash or a bank, to the holder.
- **Top up:** the amount that brings the holder back to the set float, from office cash or a bank. It shows only when a float is set and the holder holds less than it.
- **Return:** from the holder back to office cash, or deposited in a bank.

### 5.4 Cash holders
- **The account:** a ledger under Cash-in-Hand, marked as held by a person, with the person's display name and an optional set float. There can be any number of holders.
- **Not linked to HR.** A holder's float is the company's cash, never an advance to the person, and HR never shows it.
- **Paying from a holder:** a holder is a "from" choice on Pay, and a "paid from" choice for HR's cash payouts (§7.3).
- **One cash box, and it is Colour's.** All cash, including every holder's, sits in the CI book. The DP book gets no cash accounts, and Darbi's money moves through its own bank accounts. (From Anik's "all handled under one".)

### 5.5 Cash count
**What "Count cash" records,** on any cash account:
- the date;
- the counted amount;
- the book balance on that date;
- the difference;
- a note, and who counted.

**What it does:**
- It posts nothing.
- A difference shows amber on the tile until a later count matches, or until it is cleared.
- **Clearing a difference:**
  - only by a "Cash short / excess" entry made from the count: a receipt for an excess, or a payment for a shortage, against a Cash Short & Excess ledger;
  - it always waits for the MD, under a new rule key `cash_difference` (`always`), so the person who keeps the cash can't clear their own shortage;
  - a journal can't be used, because SP1 keeps cash ledgers out of journals.

  (A call made in this design.)

### 5.6 Warnings (these never refuse)
- Money left on account after Auto or Pick.
- Cash received from one party of ₹2,00,000 or more in a day (Income-tax Act s.269ST).
- Cash paid to one party of more than ₹10,000 in a day (s.40A(3)). These two warnings name the rule.
- A cash account or a holder going below zero.
- Paying from a holder more than the holder holds.

### 5.7 Keyboard
- **R, P and T** open the forms.
- **Tab and Enter** move from field to field.
- **Pickers** search as you type, using the existing `LedgerPicker`.
- **Ctrl+Enter** saves, and **Esc** closes.
- **Clone** repeats the last entry, with the last-used date.
- The Auto/Pick choice can be made without the mouse.

---

## 6. Bill-wise adjustment

### 6.1 Items
Every posted line on a party ledger is an **item**.
- **Customers:** debit items are what the customer owes (opening bills, an opening lump, and later, invoices). Credit items settle them (receipts, and later, credit notes).
- **Vendors** are the mirror image.

How an item is described:
- **Identity:** its voucher line.
- **Label:** its `bill_ref`; or "Opening balance" for an opening line without one; otherwise the voucher number.
- **Date:** `bill_date`, or else the voucher date.
- **Due date:** `due_date`.

A reversed voucher's lines, and the reversal's own lines, are not items.
*Build ruling R9:* a reversal of a reversal restores the original entry, so a posted, unreversed voucher at an even depth in its reversal chain counts as live, and its party lines are items. Depth 0 is the original and depth 2 restores it.

### 6.2 Allocations
A new table, `fin_allocations`, pairs a debit item with a credit item on the same party ledger and book, with an amount.

**Integrity rules,** enforced by the database. These are book rules, not convenience blocks:
- both lines are posted, in the same book, on the same party ledger;
- one line is a debit and the other a credit;
- neither voucher is reversed;
- the amount is greater than 0 and not NaN;
- a line's allocations never add up to more than the line's amount.

The screen never asks the user to satisfy these rules. Auto and Pick only ever propose valid allocations (§6.3, §6.4).

**Derived figures:**
- **Outstanding** of a debit item = its amount − its allocations.
- **On account** of a credit item = its amount − its allocations.

**Invariant:** for every party ledger, Σ outstanding − Σ on account = the ledger's balance.
- It holds by construction.
- A check report and the tests prove it (§13).

### 6.3 Auto
- **Order:** item date, then due date, then `bill_ref` in natural order, then line id. Opening items come first, because they are the oldest.
- **Filling:** it settles each open item in full until the money runs out. The last item may be part-settled, and anything left over stays on account.
- **New money only.** Auto spends only the money being received or paid now. A party's older on-account money has its own "Adjust" action, Auto or Pick for that credit, listed under "Unadjusted money" on the screen. (A call made in this design.)

### 6.4 Pick
- **The list:** the party's open items, oldest first, with outstanding and age. An item whose `bill_ref` matches the typed reference moves to the top, as in Pureflix.
- **Ticking** an item fills in its outstanding, until the money runs out.
- **Editing:** every amount can be changed.
- **Trimming:** ticking past the money trims the last ticked item to whatever is left.
- **Unticking** releases the item.

### 6.5 Redo later
- **Who and when:** an Accountant can redo the adjustment of any posted receipt, payment or other credit item, at any time, with Auto or Pick.
- **Effect:** it changes no balance, only which items are open.
- **Record:** it is audit-logged with before and after, and needs no approval.
- **Locked months:** a redo is allowed in closing and locked months, because a lock protects balances and an allocation changes none. (A call made in this design.)
- **Reversal:** reversing a voucher releases its allocations in the same transaction, so its bills reopen.

### 6.6 Concurrency
**The risk:** two receipts for one customer, or a receipt and a redo at the same moment, must not both spend the same bill.

**The rule:**
- Allocation writes take a per-party-ledger transaction lock. It goes right after the voucher lock in the SP1 order: series → voucher → party allocation lock → months → ledgers.
- A redo, which posts nothing, takes only the party lock.

**The trap to avoid:** never take a share lock on the party ledger and then ask for an update lock in the same transaction. Two receipts doing that would deadlock.

### 6.7 What the accountant sees
- **On Receive and Pay:** the party's open items and on-account money.
- **A party statement (Reports):**
  - open items, with outstanding and age;
  - on-account credits;
  - the invariant's two sides, next to the ledger balance.

### 6.8 What creates items
- **Now:**
  - the Opening's party lines: bill-wise from Tally, or a lump;
  - hand-made journals, receipts and payments on party ledgers.
- **Next (the invoice-feed design):** sales and purchase vouchers posted from ERP invoices and bills, with `bill_ref` = the ERP document number. They become items with no change to this engine.

---

## 7. Staff money from HR

### 7.1 HR stays the only place staff money is entered
These all stay in HR:
- Pay staff (an advance or a loan);
- Loans & Advances: Give advance, New loan, and loan prepayments;
- advance sheets;
- advances written on the month's payroll sheet;
- Mark paid (salary, per pay channel), and a single line marked paid, failed or reversed from the line drawer;
- payroll finalise and un-finalise (recoveries);
- waivers, adjustments and reversals.

They are done by whoever HR allows: today, the MD and the Accounts login.

### 7.2 What Finance posts
For each HR event, Finance posts one voucher, with `source_type` / `source_id` pointing at the HR row, at most once (H8).

| HR event | Finance voucher | Lines |
|---|---|---|
| Advance given (Pay staff, or Give advance on Loans & Advances) | payment | Dr Staff Advances · Cr the account it was paid from (§7.3) |
| Advance sheet posted | payment, one per sheet | Dr Staff Advances (advance lines) and Dr Staff Loans (loan lines) · Cr the account |
| Loan given (Pay staff, or New loan) | payment | Dr Staff Loans · Cr the account |
| Loan prepaid (money coming back) | receipt | Dr the account it came into · Cr Staff Loans |
| Advances from the month's payroll sheet | payment, one per month, posted at finalise and dated that day | Dr Staff Advances · Cr the CASH channel's account. The cash left during the month, but HR learns of it only at payroll, so the cash book catches up then, and the screen says so. (A call made in this design.) |
| Salary paid: a confirmed payment batch, or a single line from the line drawer | payment | Dr Salary Payable · Cr the account for the channel, or the cash chosen |
| Payroll month finalised | journal, dated by the book's payroll setting (§7.8) | Dr salary expense (gross, split as §7.9 says); Cr Staff Advances (advances recovered); Cr Staff Loans (loan instalments recovered); Cr Salary Payable (what HR will pay out). A negative pay carried as an advance is Dr Staff Advances. Any other deduction HR computes goes to a mapped ledger. The amount paid separately is Cr the MD's account: he pays it from his own money, so the company owes him (§16). The journal always balances. |
| Advance waived | journal | Dr the waiver expense ledger · Cr Staff Advances |
| An HR reversal, un-finalise, "unpay" or correction | a reversal of the matching voucher, then the corrected entry | mirrored; approval as §7.6 |

**Narrations:** they carry the HR document number and how many people, never names. For example: "Advances · sheet CI-ADV-0001 · 31 people" and "Salary Nov · cash · CI-PAY-0041 · 9 people".

**The staff ledgers:**
- Staff Advances, Staff Loans, Salary Payable and the salary expense ledger or ledgers (§7.9) are set up once per book. If missing, they are created under Loans & Advances (Asset), Current Liabilities and Indirect Expenses.
- They are `manual_entry = false`, so hand-typed vouchers can't touch them. H6 allows them here because `source_type` is set, and in the Opening and its corrections.
- **The MD's account,** for the amount paid separately, is an ordinary ledger the accountant picks once. Otherwise one is created under Loans (Liability) › Unsecured Loans, where a director's account usually sits in Tally. If Anik later chooses to treat those amounts as capital, that is a journal, which he approves.

**Which book carries the payroll:** the book of each person's firm.
- COLOUR → CI.
- DARBI → DP.
- No firm → CI. (A call made in this design: the people with no firm are treated as Colour's.)

### 7.3 Which account the money left from
**Pay channels map to accounts.** In Finance Setup, an Admin maps each HR pay channel to one bank or cash ledger:
- CASH → office cash, by default;
- COLOUR → a CI bank ledger;
- DARBI → whichever bank it really is.

An unmapped channel's events wait as exceptions (§7.7).

**Every HR door that moves money names the account.** HR stores the choice as a code on its own row, and Finance posts to that account:
- **Mark paid,** for a batch or a single line: a bank channel uses its mapped account; the cash channel asks office cash or a holder.
- **Pay staff, Give advance and New loan** share one "paid from" list: office cash, each holder, and the mapped banks. New loan's free-text "paid out via" becomes this list.
- **Loan prepayments** ask "received into", from the same list.
- **Advance sheets** keep their `paid_via`, now chosen from the same list.
- **Advances on the month's payroll sheet** have no account of their own. They post from the CASH channel's account (§7.2).

The principle, that HR's payouts say which cash they came from, was proposed to Anik and not objected to. The full list of HR changes is in §11.

**Inter-company, only here:**
- **When it applies:** a channel maps to a bank ledger in the DP book, while the payroll books to CI.
- **In DP:** Dr "Colour Impressions" (an inter-company ledger), Cr the DP bank.
- **In CI:** Dr Salary Payable, Cr "Darbi Print Pack".
- **Confirming it:** Anik said all money is "handled under one". The accountant confirms which bank DARBI really is when mapping it.

### 7.4 Privacy
- **Totals only.** Finance receives counts and totals per event, never a name, a code, or a per-person amount. Its audit snapshots hold the same, and nothing more.
- **Hidden people (accepted by Anik, 2026-11-20).**
  - HR hides some people from the Accounts login, including from every total, and the MD pays them himself.
  - The books can't do the same. They are one set for the accountant to keep, and the payroll totals in them include everyone. So the accountant can work out the hidden people's combined pay by subtracting HR's totals from the books' totals. Anik accepted this.
  - **Keeping it to a combined figure:** the MD's payouts to hidden people post as one combined entry per account per month, dated the month's last such payout, so no single entry shows one person's pay. Names and individual amounts never reach Finance.
  - They are all bank-paid, so cash lines reveal nothing, and their bank payouts already show on the bank statement.

### 7.5 Control check
- **The rule:** from 1 January 2027, Staff Advances and Staff Loans in Finance must equal the totals of HR's per-person balances, on any date.
- **On screen:** the Cash & Bank screen shows any gap, with a drill-down for logins that have HR access.

### 7.6 Approval of HR entries
**HR's approvals count; otherwise the seeded rules apply.** No rule changes.
- **Already approved in HR:**
  - When the HR action was done or approved by an HR approver (today the MD), the Finance entry posts without asking again, and records that approval ("approved in HR by …").
  - Today that covers salary paid (the MD approves each person's payment before it can be marked paid) and advance-sheet lines (approved by management).
- **Done by the Accounts login alone:**
  - The entry goes through the seeded rules.
  - The payroll month journal and any reversal (an un-finalise, say) always wait for the MD.
  - A payment above ₹1,00,000 (a large single advance or loan) waits too.
- **While a reversal waits,** the original stays live (H8), so the corrected entry waits with it. Both show under "HR entries waiting".
- **Why:** this keeps Anik's rule that he approves every journal and every reversal, without asking him twice for what he already approved in HR. (A call made in this design.)

### 7.7 How events reach Finance
**It never blocks HR** (SP1 principle 1).
- HR's request commits first.
- Finance then posts in its own transaction, within the same request.
- If that fails (a locked month, an unmapped channel), the event is recorded as an exception with the reason, and HR's request still succeeds.

**Catch-up:**
- The Cash & Bank screen counts HR events that have no Finance voucher yet, found by source pointer.
- It offers "Bring in from HR". Posting is idempotent under H8.

**Before the books begin:** HR events dated before 2027-01-01 are not posted. Their effect is already in the Tally opening (§7.8, §9.5).

**Exceptions:**
- Each lists the event, the reason, when it was first seen, and the fix: map the channel, reopen the month, or ask the MD.
- Resolving one posts it.

**Month locks:** with the month-end setting (§7.8), the payroll journal is dated the month end, but it posts when HR finalises, early the next month.
- So the accountant should not lock a month until its payroll has posted.
- If the month is locked, the journal becomes an exception, not a failure.

### 7.8 When the payroll month is booked (a setting per book)
- **The setting:** Finance books the payroll month either **at the month end** (accrual) or **on the day it is paid**, matching how the accountant books salary in Tally. That way the January–March parallel run lines up month by month.
- **Who sets it:** the accountant, at go-live, after checking Tally. The default is month end. (A call made in this design.)
- **December 2026, with month end:**
  - December's payroll belongs to the opening.
  - Tally's 31 December figures must hold December's unpaid salary as Salary Payable, and must reflect the advances recovered in December's payroll.
  - Only December's January payouts post.
- **December 2026, with when-paid:** December's payroll journal posts on its January payment date.

### 7.9 Staff ledgers and Tally
- **One ledger per person in Tally.** If Tally keeps a ledger per person for advances or loans, those ledgers map onto the single Finance staff ledger at the opening import, and their balances are summed. SP1's import maps one Tally row to one ledger today, so this is an import change. The monthly comparison with Tally sums them the same way.
- **A split salary expense.** If Tally splits salary expense (salary, wages, contract labour), the payroll journal splits gross the same way. A mapping from HR's person type or department to expense ledgers does it, set once by the accountant.
- **Confirming it:** the accountant checks how Tally is set up at go-live, using the real Tally exports. (Calls made in this design.)

---

## 8. Approvals, in one place
- **Unchanged, as seeded:**
  - receipt: `never`;
  - payment and contra: above ₹1,00,000;
  - journal, opening and reversal: `always`.
- **HR entries:** count approvals already given in HR, and otherwise follow the seeded rules (§7.6).
- **New:**
  - `cash_difference`, `always`, for clearing a cash-count difference (§5.5);
  - the opening correction uses the `opening` rule, which is `always` (§9.4).
- **No approval needed:** redoing an adjustment, and the cash count itself.

---

## 9. Opening balances

### 9.1 From Tally (already built, unchanged)
- The 31 December 2026 Opening carries every ledger's balance, and each party's open bills, bill by bill.
- The ERP's existing receipts are not carried into Finance. The Tally opening is the position at 31 December.

### 9.2 A holder's opening float
Recorded as a transfer from office cash to the holder on 1 January. Tally keeps a single cash figure.

### 9.3 Old dues with no bill break-up
An opening party line with no `bill_ref` is a single item, "Opening balance". Auto settles it first, because it is the oldest.

### 9.4 Opening correction (new)
**What it is:**
- A journal dated the Opening's date, marked as an opening correction.
- It changes only the figures that were wrong. Its lines sum to zero, and they may include bill-wise party lines.

**Rules:**
- **Approval:** it always needs an Approver (the `opening` rule).
- **Locks:** it is allowed only while no later month is locked. If a later month is closing, approval is needed anyway (R70/R73, as for the Opening).
- **Hard stops:** H5 widens to accept an opening correction in the `before_books` month, and H6 treats it as it treats the Opening.
- **How many:** any number. Each one is a voucher and can be reversed like any other.

**On screen:** the Opening view shows "Opening + corrections" for each ledger.

### 9.5 The cut-over check on 1 January
- **Staff advances and loans:** Staff Advances and Staff Loans in the opening must equal HR's per-person totals as at 31 December.
- **Salary payable:** with the month-end setting (§7.8), Salary Payable must equal December's net pay still unpaid on 31 December; if Tally didn't book it, an opening correction adds it. With the when-paid setting, there is nothing to check here.
- **Fixing differences:** they show on the control check (§7.5) and are fixed with an opening correction.

---

## 10. Data changes in Finance (one new named migration)
- **`fin_ledgers`:** a holder's display name and an optional set float. A small `fin_cash_holders` table would also do; the builder chooses.
- **`fin_allocations`** (new, §6.2), with its integrity rules.
- **`fin_cash_counts`** (new, §5.5).
- **`fin_channel_accounts`** (new): for each book, HR pay channel code → ledger, plus the accounts HR may offer as "paid from" (office cash, holders, mapped banks) (§7.3).
- **`fin_hr_exceptions`** (new, §7.7).
- **`fin_vouchers`:** a way to mark an opening correction, either a flag or a new `voucher_type` (the builder chooses), with H5, H6 and H8 adjusted to match.
- **`fin_approval_rules.rule_key`** accepts `cash_difference`. The setup script seeds it as `always` for both books.
- **The payroll setting** per book (§7.8), and the **expense mapping** from HR person type or department to ledgers (§7.9).
- **The opening import** may map several Tally ledgers onto one Finance staff ledger, summing them (§7.9).
- **Security and realtime:** the new tables join Finance's RLS block (RLS on, anon and authenticated revoked) and its realtime block.
- **The migration:**
  - one new file, idempotent;
  - replayed by `db.js init()` after the Finance one;
  - applied to production by hand at go-live, as a named migration, after a dry run.

---

## 11. Changes outside Finance (the complete list)

| # | Where | Change | Agreed |
|---|---|---|---|
| 1 | HR tables (one HR migration) | `hr.advance_txns` gains a nullable `paid_via`. `hr.payment_batches` and the single-line payment record gain the cash they were paid from. Loan prepayments gain the account they were received into. | New in this design; Anik to approve |
| 2 | HR screens: Pay staff, Give advance, New loan, loan prepayment, advance sheets, Mark paid (batch and single line) | One "paid from" / "received into" list (office cash, holders, mapped banks), read from Finance's channel map. New loan's free text becomes that list. HR stores the code. | Principle proposed 2026-11-20, no objection; the full list is new here, Anik to approve |
| 3 | HR routes for all of those, plus finalise, un-finalise and reversals | After HR's commit, call Finance's HR poster. It never fails HR's request. | New in this design; Anik to approve |
| 3a | HR advance sheets: `PUT /hr/advance-sheets/:id/lines` | A line already posted can't be dropped or changed: 409 "Lines already paid out can't be changed." This is HR's own rule (a posted sheet's lines are locked), now held when a sheet posts in rounds and goes back to draft, so the Finance entry of a posted round stays as it was booked. | Build ruling R25 (2026-11-21) |
| 3b | HR Reports › monthly schedule (`hr/monthly-report.js`) | HR's monthly schedule reads a paid-from code by the account it names: office cash, a holder or the cash channel is cash; a bank, or a bank channel, is bank; a `fin:` code is read through Finance's ledger. A Pay-staff advance is read by the code its row keeps, and by its note only when it is older than that. | Build ruling R43 (2026-11-21) |
| 4 | ERP Invoices page | From 1 Jan 2027, Record Payment opens Finance's Receive with the customer filled in, for a login with a Finance Accountant grant on the invoice's book. Other logins see "Receipts are recorded in Finance". Before 1 January it works as it does today. | Approach A, chosen 2026-11-20 |
| 5 | ERP Accounts page | From 1 Jan 2027, the Cash & Bank Book, Party Ledger and Payables tabs show a notice that links to Finance. Purchase Bills stays; the invoice-feed design decides its future. | Approach A |
| 6 | ERP vendor payments | The prefix `CI-PAY-` becomes `CI-VP-` (no rows exist yet). From 1 Jan 2027 its button opens Finance's Pay. | Proposed 2026-11-20, no objection; Approach A |
| 7 | Shared files | `AppLayout.jsx`: the nav item and its short label. `writeOnce.js`: `MINTING_POSTS` for the new minting routes. `notify-categories.js`: only if a new kind is added. `db.js`: one migration line. `app.js`: nothing, because the Finance router is already mounted. | The same pattern as SP1 §12 |

Nothing else outside Finance changes.

---

## 12. Order and timing
1. **This design:** built next, and live before 1 January 2027.
2. **The invoice-feed design:** straight after, and also live before 1 January 2027.

Until (2) lands:
- receipts settle opening bills, or wait on account;
- "Unadjusted money" lists them, ready for Auto once the invoices arrive.

---

## 13. Trying it out, and testing
- **Dummy data on a local copy only:** embedded Postgres, invented names, never real staff. Dummy data never goes into the live books.
- **A practice book on motionci.in** is offered, but not included.
- **Tests,** beyond SP1's patterns:
  - **The invariant,** on generated data (property tests).
  - **Auto:** its order, and its trims.
  - **Pick:** its trims.
  - **Redo.**
  - **Reversal** releasing allocations.
  - **Concurrency:** two receipts for one party, and a receipt with a redo (§6.6).
  - **The HR feed:** exactly once, from every door in §7.1; reversals; exceptions; skipping events from before the books begin; both payroll settings (§7.8).
  - **Privacy:** no names in any Finance response, or in any audit row, built from HR data; payouts to hidden people post only as one combined entry per account per month (§7.4).
  - **Paid separately** posts to the MD's account, and the payroll journal still balances (§7.2).
  - **The opening correction** under locks (R70).
  - **Approval routing** for HR entries: approved in HR, versus done by the Accounts login alone (§7.6); and `cash_difference` (§5.5).
  - **Payload size** of the book view on a large month.

---

## 14. Left to the builder
- Table shapes where §10 offers a choice.
- The exact mechanics of the HR → Finance call and the catch-up, within §7.7's rules.
- Keyboard keys beyond R, P, T and Ctrl+Enter.
- Layout details, within the ERP's recipe.
- The names of the system ledgers, and their exact groups.
- Report shapes.
- How the "Unadjusted money" and "HR entries waiting" counts are fetched, using count-only reads.
- Where the bills picked on a voucher that waits for approval are kept until it posts (they are applied when it posts).
- How one HR event that posts in both books (the DARBI pair, §7.3) gets two source keys under H8.
- The rounding ledger, if HR's rupee rounding needs one.
- HR's own migration for §11 item 1, alongside Finance's.

---

## 15. Calls made in this design (for Anik to check)
1. Auto spends only the new money. Older on-account money gets its own Adjust (§6.3).
2. Redoing an adjustment is allowed even in locked months, and needs no approval (§6.5).
3. Customer receipts and vendor payments have a "TDS deducted" field, as an amount only (§5.1, §5.2).
4. Cash-limit warnings under s.269ST and s.40A(3) (§5.6).
5. HR entries count approvals already given in HR. Otherwise the seeded rules apply, so journals and reversals still always reach the MD (§7.6).
6. HR posts to Finance after HR's own commit, and failures become exceptions (§7.7).
7. The ERP's Record Payment keeps working as it does today until 1 January (§11, item 4).
8. Holder floats are not linked to HR (§5.4).
9. A cash count only records; it posts nothing (§5.5).
10. The people with no firm book to Colour (§7.2).
11. The payroll month is booked at the month end or when paid, by a per-book setting the accountant matches to Tally at go-live. The default is month end (§7.8).
12. Vouchers waiting for approval show greyed in the book, outside the balance (§5).
13. A cash-count difference is cleared only by a "Cash short / excess" entry, which always waits for the MD (§5.5).
14. Advances written on the month's payroll sheet post at finalise, from the CASH channel's account (§7.2).
15. Several Tally staff ledgers may map onto one Finance staff ledger, and salary expense may split by HR person type or department (§7.9).
16. There is one cash box, in the CI book; the DP book has none. This is my reading of "all handled under one" (§5.4).
17. The amount paid separately goes to an MD's account ledger that the accountant picks once, and the company owes the MD that amount. Treating it as capital later is a journal he approves (§7.2).

---

## 16. Anik's answers to the builder check (2026-11-20)
He answered "ok go ahead" to the recommendation given for each question.
1. **Hidden people in the books' totals (§7.4): yes.** The accountant may be able to work out the hidden people's combined pay from the books, but never names or individual figures. The books must carry total salary.
2. **The amount paid separately (§7.2): the MD's own money.** The payroll's "paid separately" column (headed with the MD's name in the salary workbook) is paid outside the bank and cash runs, from his own money, so the company owes him. Two other possibilities are ruled out: company money he hands over, and money that isn't company salary at all.
