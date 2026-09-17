// Which of several overlapping fetches of the same list may paint the screen.
//
// The Plates History tab is fetched by the tab opening AND by load() — a realtime
// ping, or a refresh after an issue/retire/verify — and those overlap. An answer
// may be thrown away only when a NEWER ANSWER HAS ALREADY LANDED, never merely
// because a newer request started: that newer request can still fail (a tablet
// on flaky Wi-Fi), and a realtime load() swallows its failure without a toast, so
// the tab would sit on "Loading history…" with a good answer discarded.
//
// Every fetch takes a number when it starts (begin). accept(seq) says whether its
// answer lands: yes if it is newer than whatever is on screen, and then it becomes
// what is on screen. An older answer arriving after a newer one has landed is
// still refused — a plate just retired must not reappear because the slow answer
// came in last.
export function newestAnswerGate() {
  let started = 0;
  let landed = 0;
  return {
    begin: () => ++started,
    accept: seq => {
      if (seq <= landed) return false;
      landed = seq;
      return true;
    },
  };
}
