// Broadcast has no replay on a public channel: whatever the database announced
// while the socket was down is gone. So the first SUBSCRIBED after a break —
// CHANNEL_ERROR, TIMED_OUT or CLOSED following an earlier SUBSCRIBED — must make
// every live screen reload once. The very first SUBSCRIBED does not: screens load
// on mount, and their requests started before the feed went live can never be
// served from the cache anyway (responseCache rule 2), so the next poll or change
// fetches them.
export function createStatusTracker() {
  let everSubscribed = false;
  let brokenSince = false;
  return {
    next(status) {
      if (status === 'SUBSCRIBED') {
        const catchUp = everSubscribed && brokenSince;
        everSubscribed = true;
        brokenSince = false;
        return { catchUp };
      }
      if (everSubscribed) brokenSince = true;
      return { catchUp: false };
    },
  };
}
