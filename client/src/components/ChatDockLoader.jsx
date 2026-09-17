// The messenger dock, loaded as its own chunk instead of riding in the entry.
// Chat.jsx and its icons were ~42 KB of JavaScript every plant tablet parsed on
// a cold load before the shell could paint, for a button whose first job — the
// unread badge — can arrive a beat after the top bar without anyone losing work.
//
// Three things make the deferral safe, and each is load-bearing:
//   1. The placeholder IS the dock's trigger (same wrapper, same CountButton,
//      no badge), so the top bar does not shift when the real one swaps in, and
//      tapping it while loading still opens the messenger.
//   2. An error boundary. A lazy chunk that fails to fetch — a Wi-Fi blip at the
//      press — throws; unfenced, that throw unmounts AppLayout and blanks the
//      whole station screen on every route. Here it leaves the placeholder,
//      which retries on tap. (index.html's vite:preloadError budget may reload
//      the page first; that is the same recovery every route chunk already has.)
//   3. The open queue (lib/chatOpenQueue.js). Every module opens a thread by
//      firing `ci-chat-open`; until Chat.jsx mounts nobody hears it, so the last
//      request is held and replayed the moment the dock's listener is live.
import { Component, Suspense, lazy, useEffect } from 'react';
import { MessageCircle } from 'lucide-react';
import { CountButton } from './TopBar.jsx';
import { CHAT_OPEN_EVENT, createChatOpenQueue } from '../lib/chatOpenQueue.js';

const queue = typeof window === 'undefined' ? null : createChatOpenQueue(window);

// React.lazy remembers a rejection forever, so a retry needs a fresh one.
const loadDock = () => lazy(() => import('./Chat.jsx'));
let Dock = loadDock();

// Same request the `g m` chord sends: open on the inbox, no thread to resolve.
const requestOpen = () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: {} }));

function DockPlaceholder({ title, onClick }) {
  // Mirrors Chat.jsx's root (`no-print relative shrink-0`) and its trigger, so
  // the swap is invisible apart from the badge appearing.
  return (
    <div className="no-print relative shrink-0">
      <CountButton icon={MessageCircle} label="Messages" count={null} title={title} onClick={onClick} />
    </div>
  );
}

// Rendered AFTER <Dock /> inside the same Suspense: its effect runs once the
// dock's own `ci-chat-open` listener is registered, never before.
function DockReady() {
  useEffect(() => queue?.dockMounted(), []);
  return null;
}

class DockBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, attempt: 0 };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('CI Messenger failed to load', error);
  }

  // While failed, every held open request — Production "Discuss", a ThreadCell,
  // the bell, the g m chord — retries the load, not only a tap on the placeholder.
  // On mount too: `Dock` is module-level and stays rejected, so a boundary remounted
  // by a tier switch renders straight into the failed state without an update.
  componentDidMount() {
    if (this.state.failed) this.stopHeld = queue?.onHeld(() => this.retry());
  }

  componentDidUpdate(_prevProps, prevState) {
    if (this.state.failed && !prevState.failed) this.stopHeld = queue?.onHeld(() => this.retry());
    if (!this.state.failed && prevState.failed) this.unsubscribeHeld();
  }

  componentWillUnmount() {
    this.unsubscribeHeld();
  }

  unsubscribeHeld() {
    this.stopHeld?.();
    this.stopHeld = null;
  }

  retry = () => {
    if (!this.state.failed) return;
    // Unsubscribe FIRST: the tap's own request below is held too, and must not
    // re-enter this retry through the listener.
    this.unsubscribeHeld();
    // A tap asks for the inbox — unless a specific thread is already held, which
    // the retry must deliver instead of replacing it with {}.
    if (!queue?.hasPending()) requestOpen(); // held by the queue, replayed when the retry lands
    Dock = loadDock();
    this.setState(s => ({ failed: false, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <DockPlaceholder title="CI Messenger did not load — tap to retry" onClick={this.retry} />;
    }
    return this.props.children(this.state.attempt);
  }
}

export default function ChatDock() {
  useEffect(() => queue?.watch(), []);
  return (
    <DockBoundary>
      {attempt => (
        <Suspense key={attempt} fallback={<DockPlaceholder title="Loading CI Messenger… (g m)" onClick={requestOpen} />}>
          <Dock />
          <DockReady />
        </Suspense>
      )}
    </DockBoundary>
  );
}
