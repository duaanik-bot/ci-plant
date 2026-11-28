# iPhone Duo — layout audit and changes (28 Nov 2026)

Two releases: the edge-to-edge Duo layout (`a65f3059`) and this follow-up. Front end only. No server, API, database
or environment change.

## Screen sizes

Apple publishes only pixel counts (outer 1398 × 2034, inner 1878 × 2670). The CSS sizes used here come from Apple's
iOS 27 design kit: **outer 466 × 678**, **inner 669 × 951**, both at 3× scale. The rules also cover the older
626 × 890 estimate for the inner screen, so either value works.

| Posture | Home-screen app | Safari (bars showing) | Chrome (bars showing) |
|---|---|---|---|
| Folded, upright | 466 × 678 | 466 × ~580 | 466 × ~540 |
| Folded, sideways | 678 × 466 | 678 × ~416 | 678 × ~400 |
| Unfolded, upright | 669 × 951 | 669 × ~850 | — |
| Unfolded, sideways | 951 × 669 | 951 × ~600 | — |

The Duo rules match only touch screens that are 450–743 wide, at least 380 tall and no wider than 7:4, or touch
screens in landscape that are 744–1023 wide and at least 450 tall. The 7:4 limit and the 380 floor exist so Safari's
bars on the folded-sideways screen (678 × ~416) still count as a Duo. The SE sideways (667 × 375) stays out because it
is under 380 tall; the 8 Plus and older Androids sideways stay out because they are about 1.78 wide-to-tall.

## Changes in this release

| File | Change |
|---|---|
| `index.css`, `autoCards.js`, `tailwind.config.js` | The folded-sideways Duo stays on the Duo layout in Safari and Chrome. The minimum height was 450, which Safari's bars pushed it below; it is now 380 plus the 7:4 limit. |
| `index.css` | **See-through bars.** The top bar, tab bar and side rail use the app's blue-grey at about 60% with a 24px blur, so the page shows through them as it does in iOS's own bars. The page fills every edge (side camera strip, home bar, overscroll) in its own tone, never black or white. |
| `index.css` | On the folded screen held upright, a dialog that contains a field opens **full screen**: square, header clear of the Dynamic Island, Save row clear of the home bar. A plain confirm keeps the small sheet. |
| `index.css` | A long word (an e-mail address, a run of job numbers) inside a shrinkable box wraps instead of pushing past the screen edge. |
| `ui.jsx` | Modal passes the visual-viewport height to CSS as `--ci-vvh`, so a full-screen form stops at the keyboard. |
| `duoFocus.js` (new), `main.jsx` | Duo only: the field you tap scrolls to the middle of the space left above the keyboard. It recognises the Duo by its screen size, so it still works when the keyboard shrinks the window. |
| `autoCards.js` | After you fold or unfold, a table that now fits is shown as a table again instead of staying as cards. A table 2 to 4 px too wide (previously let through) now becomes cards. |
| `Production.jsx` | Job-card title chips (the Fluence button and others) wrap on the Duo instead of running 100 px off the folded screen. The class used has rules only on the Duo. |

## Tests

Run in headless Chrome against the real app and live data (read-only), emulating a touch screen at 3× scale.

**1. Every page in 12 Duo screen sizes** (the table above, plus the 626 × 890 estimate upright and sideways). There
are 41 routes: home, orders, planning, print planning, production, board stock verification, procurement,
inventory, finished goods, dispatch, direct invoice, invoices, status sheet, reports, masters, tooling (plates,
dies, blocks, shade cards), shade cards, costing, accounts, finance, HR, floor (all stations), artwork, COA
register, extra sheets, stock write-ons, stage discrepancies, cutting variances, logbook, Fluence, AVS, kit
studio and track.

- On each page the test clicked up to 6 tabs and opened up to 4 dialogs from New / Add / Create / Raise / Record
  buttons.
- **492 of 492 page checks passed.**
  - Page width never exceeded the screen width.
  - No element sat past the right edge unless it was inside its own scroller.
- **1,752 tab views passed.**
- **140 dialog openings passed**, 35 of them full screen on the folded screen. The 10 dialogs were New Order, New
  Customer, Create GRN, Create PO, New Requisition, Raise Purchase Requisition, Add Leftover Stock, Record
  Payment, New Shade Card and New Request.
  - Each dialog sat inside the screen, its footer was visible, and its content did not overflow sideways.
- **Keyboard (138 checks):** the visual viewport was cut by the keyboard's height (~335 upright, ~245 sideways)
  with the layout viewport left unchanged, which is what iOS does. In every case the focused last field, the
  sheet and its footer stayed reachable.
- No JavaScript errors.

**2. Row and card taps.** The first row or card on 23 pages was tapped in 4 Duo postures: folded upright, folded
sideways in Safari, unfolded upright and unfolded sideways. This covers edit forms, side drawers and detail
sheets: order detail, requisition detail, plate request form, die detail, shade card, artwork form, COA, AVS
product, inventory and others. **74 of 74 passed**, with nothing outside the screen and no sideways overflow.

**3. No change on any other device.** The built stylesheet was compared before and after, listing the rules that
apply at each of 36 screen sizes. The lists are **identical** for:

- desktop windows (1440, 1024, 620 and 700 × 420 with a mouse)
- iPhone SE, 15 and Pro Max, upright and sideways
- iPhone 8 Plus sideways
- Android 412, upright and sideways
- Nexus 5X sideways
- iPad mini, iPad and iPad Pro 13", upright and sideways

**4. `npm run verify`:** schema baseline unchanged, 5,074 passed, 0 failed, build OK.

## Known limits

- **Not measured on a physical Duo.** There was no Xcode or simulator on this Mac, so Safari, Chrome and the
  home-screen app were emulated at their CSS sizes.
- **iPad half-screen Split View** (about 566–600 wide) matches the Duo rules. Since the first release it gets the
  Duo look, and now full-screen forms as well. Full-screen iPads are unaffected.
- **Android foldables.** An open Galaxy Fold or Pixel Fold is close to the Duo's size and also gets the Duo look.
- **An old 640 × 384 Android held sideways** would also match. In practice its browser bars keep it under 380 tall.
- **The status bar in the home-screen app** follows `apple-mobile-web-app-status-bar-style` (`default`). That tag
  applies to every iPhone, so it was not changed. In Safari the strip takes the page's tone (`theme-color` #E9EDF6).
- **Submitting forms** was not part of the test. The test database is read-only, and saving does not depend on
  layout.
