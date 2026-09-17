// Holds a `ci-chat-open` request that arrives before the messenger dock can hear
// it. The dock (components/Chat.jsx) is a lazy chunk now, so for the first few
// hundred ms of a cold load — longer on plant Wi-Fi — nothing listens for the
// event every module fires to open a thread: Production's "Discuss", a record's
// ThreadCell, the bell's chat handoff, the `g m` chord. A click in that window
// used to be answered; dropping it silently would read as a dead button.
//
// Only the LAST request is kept: two quick clicks mean the operator changed
// their mind, and replaying both would flash one thread and land on the other.
// The queue only listens while a loader is mounted (watch), so a stray event on
// a screen with no shell is not saved up to pop the dock open later.
//
// Pure — the event target is injected — so node --test can drive it.
export const CHAT_OPEN_EVENT = 'ci-chat-open';

export function createChatOpenQueue(target) {
  let pending = null;
  let docks = 0; // mounted docks; >0 means Chat.jsx's own listener is live
  const heldListeners = new Set();

  return {
    // Start catching requests. Returns the stop function (an effect cleanup).
    watch() {
      const hold = e => {
        if (docks > 0) return;
        pending = e.detail || {};
        for (const cb of heldListeners) cb(pending);
      };
      target.addEventListener(CHAT_OPEN_EVENT, hold);
      return () => target.removeEventListener(CHAT_OPEN_EVENT, hold);
    },

    // A loader whose chunk failed subscribes here: any open request (Discuss,
    // a ThreadCell, the bell, g m) is then a reason to retry the load, not only a
    // tap on the placeholder. Returns the unsubscribe function.
    onHeld(cb) {
      heldListeners.add(cb);
      return () => heldListeners.delete(cb);
    },

    hasPending() {
      return pending != null;
    },

    // Call once the dock's listener is registered (a later sibling's effect).
    // The count goes up BEFORE the replay so the queue ignores its own echo.
    dockMounted() {
      docks += 1;
      if (pending) {
        const detail = pending;
        pending = null;
        target.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail }));
      }
      return () => { docks -= 1; };
    },
  };
}
