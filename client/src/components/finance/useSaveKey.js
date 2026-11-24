// useSaveKey: Ctrl or Cmd with Enter saves, wherever focus is, while a Cash & Bank form or dialog is open (Cash & Bank spec §5.7;
// ruling R72): Receive, Pay and Transfer (CashEntryForm), Redo and Adjust (AdjustDialog), and the cash count (CashCountDialog).
//
//   useSaveKey(save, enabled)   `save` is the form's own save; `enabled` is false while something over the form has the keys (the entry
//                               form's "Close without saving?").
//
// A key caught on an element inside the dialog is lost once focus has left it: a bill ticked with the mouse re-renders its row, and focus
// falls to the page's body, outside every dialog (the walkthrough's W1). So the key is caught on window, in the capture phase, the way the
// page's r, p and t are (useEntryKeys), before anything inside the dialog sees it: a picker would take the Enter as a choice. The save it
// calls keeps its own one-at-a-time guard (savingRef, ruling R57), so a press the browser sends twice saves once.
import { useEffect, useRef } from 'react';

// The listener, given what it saves with: Ctrl or Cmd with Enter, neither held down (a held key repeats) nor in the middle of an input
// method's composition (its Enter picks a word), is the save, and goes no further. Any other key is left as it was.
export function finSaveKeyListener(save) {
  return e => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing || e.repeat) return;
    e.preventDefault();
    e.stopPropagation();
    save();
  };
}

export default function useSaveKey(save, enabled = true) {
  const latest = useRef(save);
  useEffect(() => { latest.current = save; }, [save]);
  useEffect(() => {
    if (!enabled) return undefined;
    const listen = finSaveKeyListener(() => latest.current());
    window.addEventListener('keydown', listen, true);
    return () => window.removeEventListener('keydown', listen, true);
  }, [enabled]);
}
