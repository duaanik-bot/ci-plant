// How a Setup form saves, in one place:
//
//   const { problems, attempt } = useFormWrite();
//   const save = async () => {
//     if (await attempt(() => api.put(...), { onFail: reload })) { toast.success('Saved'); await onSaved(); }
//   };
//
// `attempt(write)` runs the write and answers whether it went through. The save button hands the PROMISE back (the shared Button stays
// busy until it settles, so a second press does nothing), and the form stays open on a refusal so nothing typed is lost.
//   • A refusal carries the server's sentence, which api.js has already toasted; it is also kept in `problems`, under the field it is
//     about (a name that is taken, a limit that is not an amount: finProblemField) or, when it is about the form as a whole (the last
//     Admin of a book), under `form`, for the foot of the form to draw, so a form that stays open says why.
//   • A write that got no answer at all (the connection dropped) is said by useNoAnswer: api.js toasts only what the server said.
//   • `onFail` runs after a failure and before the answer: another login may have changed what the form was built from (a group deleted
//     under it, a ledger switched off), and the list behind it should show the truth.
// The write is never retried here; whether to try again is the person's.
import { useCallback, useState } from 'react';
import useNoAnswer from './useNoAnswer.js';
import { finProblemField } from '../../lib/finance/setup.js';

export default function useFormWrite() {
  const noAnswer = useNoAnswer();
  const [problems, setProblems] = useState({});

  const attempt = useCallback(async (write, { onFail } = {}) => {
    setProblems({});
    try {
      await write();
      return true;
    } catch (e) {
      noAnswer(e);
      // Under the field it is about (finProblemField), else `form`, for the foot of the form: a refusal with an HTTP status has said its
      // sentence in a toast that goes, and a form that stays open should still say why.
      const field = finProblemField(e);
      if (field) setProblems({ [field]: e.message });
      else if (Number.isInteger(e?.status)) setProblems({ form: e.message });
      try { await onFail?.(); } catch { /* the reload says for itself when it fails */ }
      return false;
    }
  }, [noAnswer]);

  return { problems, attempt };
}
