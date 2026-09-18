// A button that is saving cannot be pressed again.
//
// No save button in the app showed a busy state, so a double-click, or a second
// press while a slow save was still on its way, sent the write twice: a second
// GRN, PR, payment, box. lib/writeOnce.js already joins an IDENTICAL minting
// POST that is still in flight; this closes the rest at the button itself —
// every write, minting or not, and a second press that differs (a form edited
// between the two presses) as much as one that does not.
//
// The rule: when a button's onClick RETURNS a promise, the button is busy until
// that promise settles — disabled, aria-busy, and after SPIN_AFTER_MS a spinner
// so a slow save shows it is working. A press while busy does nothing. A
// handler that returns nothing is left exactly as it was.
//
// Two ways out, both deliberate:
//   repeatable  — for buttons whose second press IS a second action even while
//                 the first is on the wire (a queue arrow that moves one place
//                 per tap). The caller opts out by name.
//   BUSY_MAX_MS — a promise that never settles (a dialog dismissed without
//                 answering, a request on a dead connection) must not leave a
//                 button dead: past the server's own limit (vercel.json
//                 maxDuration 30 s, plus margin — the same window writeOnce
//                 uses) it is pressable again.
//
// Pure — no React — so the server suite can pin it; components/ui.jsx Button
// wires it to state.

export const SPIN_AFTER_MS = 300;
export const BUSY_MAX_MS = 35_000;

// onBusy(true|false) mirrors the busy flag into the component; onSpin(true|false)
// the spinner. Timers are injectable for tests.
export function createBusyGuard({ onBusy = () => {}, onSpin = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let busy = false;
  let timers = [];
  let token = 0;
  const release = mine => {
    if (mine !== token) return;               // a newer press already owns the guard
    timers.forEach(clearTimer); timers = [];
    busy = false;
    onSpin(false);
    onBusy(false);
  };
  return {
    get busy() { return busy; },
    // Runs the handler for a press. Returns what the handler returned (or
    // undefined when the press was swallowed because a save is on its way).
    press(handler, event) {
      if (busy) { event?.preventDefault?.(); return undefined; }
      const out = handler?.(event);
      if (!out || typeof out.then !== 'function') return out;
      busy = true;
      const mine = ++token;
      onBusy(true);
      timers = [
        setTimer(() => { if (mine === token && busy) onSpin(true); }, SPIN_AFTER_MS),
        setTimer(() => release(mine), BUSY_MAX_MS),
      ];
      Promise.resolve(out).then(() => release(mine), () => release(mine));
      return out;
    },
    // The component is going away: stop every timer, report nothing more.
    dispose() { timers.forEach(clearTimer); timers = []; token++; onBusy = onSpin = () => {}; },
  };
}
