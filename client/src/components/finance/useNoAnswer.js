// A write that got no answer at all, because the connection dropped, would be silent: api.js toasts what the SERVER said (an HTTP
// error), and a dropped connection said nothing. This is the one place the Finance screens say so, in one sentence (voucher.js,
// FIN_NO_ANSWER_NOTE), for the form's save, the detail's actions, the dialogs' writes and the list's row buttons alike.
//
//   const noAnswer = useNoAnswer();
//   try { await api.post(...); } catch (e) { noAnswer(e); throw e; }
//
// It stays quiet when the answer was a refusal (an error with a status: api.js has toasted it) and when the login was just signed out:
// a 401 reaches the screen as an error with no status too, but api.js has cleared the token and the app is already on its way to the
// sign-in page, where "couldn't reach the server" would be a lie.
import { useCallback } from 'react';
import { auth } from '../../api.js';
import { useToast } from '../ui.jsx';
import { FIN_NO_ANSWER_NOTE, finIsNoAnswer } from '../../lib/finance/voucher.js';

export default function useNoAnswer() {
  const toast = useToast();
  return useCallback(error => {
    if (finIsNoAnswer(error) && auth.token) toast.error(FIN_NO_ANSWER_NOTE);
  }, [toast]);
}
