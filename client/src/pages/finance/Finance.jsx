// Finance — the books of account (fin_*): the shell that Vouchers, Reports, Setup and the voucher print sit in.
//
//   /finance                       Vouchers     Day Book, Approvals, Drafts
//   /finance/reports/*             Reports
//   /finance/setup/*               Setup
//   /finance/vouchers/:id/print    VoucherPrint
//
// The shell asks GET /finance/me: who this login is, and the books it holds a Finance grant on, with its roles in each.
// A login with no grant at all gets one sentence and nothing else; a request that failed gets one short line and a Retry
// (never the "not switched on" sentence, which is for an answer with no books). Otherwise the pages work in ONE book at a
// time: the book switch (drawn for a login that holds more than one) picks it, and the pick is remembered in storage under
// fin_book. Every page is given the same five things:
//
//   me       the /finance/me answer
//   book     the current book: { id, code, name, billing_entity_id, books_begin, roles, can_export }
//   can      can(cap) is finCan on this book's roles: view, enter, ledger, import, approve, admin. Export is no capability
//            (spec §8.1): it is the book's own can_export flag. The screens hide what a login cannot do; the server
//            refuses it regardless.
//   setBook  setBook(id) switches the shell to another of this login's books and answers true; a book the login does not
//            hold changes nothing and answers false. A bell link names a voucher and no book, so the Vouchers page uses
//            it to open a voucher in the voucher's own book.
//   reloadMe reloadMe() asks /finance/me again and answers a promise of the new answer (it rejects if the request fails). Setup →
//            Access calls it after a grant or a revoke for the login's OWN id, so the books and roles every page is given follow at
//            once, with no reload (ruling R60). The shell stays on the book it is on while the new answer still lists it, falls
//            back to the first book when it does not, and with no book left says the no-grant sentence (finBookAfterReload).
//
// A page is a chunk of its own, fetched the first time it is opened, so the shell stays small however large they grow.
// The pages are drawn afresh when the book changes (the key on Routes), so nothing one book showed can sit on screen
// under the other's name.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from '../../api.js';
import BookSwitch from '../../components/finance/BookSwitch.jsx';
import { Button } from '../../components/ui.jsx';
import { finBookAfterReload, finBookOf, finPickBook } from '../../lib/finance/book.js';
import { finCan } from '../../lib/finance/caps.js';
import { storage } from '../../lib/safeStorage.js';

const Vouchers = lazy(() => import('./Vouchers.jsx'));
const Reports = lazy(() => import('./Reports.jsx'));
const Setup = lazy(() => import('./Setup.jsx'));
const VoucherPrint = lazy(() => import('./VoucherPrint.jsx'));

// The same quiet line the other pages show while they load.
const Loading = () => <div className="py-20 text-center text-sm text-gray-400">Loading…</div>;

// The one request for who this login is: the first load asks it, and so does reloadMe.
const loadMe = () => api.get('/finance/me');

export default function Finance() {
  const [me, setMe] = useState(null);
  const [failed, setFailed] = useState(false);
  // How many times /finance/me has been asked for: Retry asks again by moving it on.
  const [attempt, setAttempt] = useState(0);
  // What the browser kept from the last visit. finPickBook uses it only while it still names one of this login's books.
  const [remembered, setRemembered] = useState(() => storage.getItem('fin_book'));

  useEffect(() => {
    let live = true;
    // The server's own sentence, when there is one, has already reached the toast (api.js), so it is not said again here;
    // a dropped connection has no sentence at all, which is why the failure is shown on the page.
    loadMe()
      .then(answer => { if (live) setMe(answer); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);

  const book = me ? finPickBook(me.books, remembered) : null;
  // The book on screen, kept for reloadMe, which may be called long after the render that made it. Written by an effect and not
  // during a render, which React may throw away.
  const bookRef = useRef(null);
  useEffect(() => { bookRef.current = book; }, [book]);
  // The same function for as long as the book is the same, so a page may list it among an effect's dependencies.
  const can = useMemo(() => cap => finCan(book?.roles, cap), [book]);
  // The one door by which the book changes, for the book switch and for the pages alike: only a book this login holds.
  const setBook = useCallback(id => {
    const next = finBookOf(me?.books, id);
    if (!next) return false;
    setRemembered(String(next.id));
    storage.setItem('fin_book', String(next.id));
    return true;
  }, [me]);
  // Ruling R60: ask who this login is again, for a grant or a revoke that changed what it may do. The book to be on is decided with the
  // new answer in hand (finBookAfterReload) and set together with it, so the page never draws the new roles under another book. A
  // failed request rejects for the caller, who can say so; the shell keeps what it had.
  const reloadMe = useCallback(() => loadMe().then(answer => {
    const next = finBookAfterReload(answer.books, bookRef.current);
    setRemembered(next ? String(next.id) : null);
    setMe(answer);
    return answer;
  }), []);
  const retry = () => { setFailed(false); setAttempt(n => n + 1); };

  if (!me) {
    return failed ? (
      <div className="flex flex-col items-center gap-3 py-20 text-sm text-slate-500">
        <p>Finance didn't load.</p>
        <Button variant="secondary" onClick={retry}>Retry</Button>
      </div>
    ) : <Loading />;
  }
  if (!book) return <p className="py-20 text-center text-sm text-slate-500">Finance isn't switched on for this login — ask the MD.</p>;

  return (
    <div>
      {me.books.length > 1 && (
        <div className="no-print">
          <BookSwitch books={me.books} value={book.id} onChange={setBook} />
        </div>
      )}
      <Suspense fallback={<Loading />}>
        <Routes key={book.id}>
          <Route index element={<Vouchers me={me} book={book} can={can} setBook={setBook} reloadMe={reloadMe} />} />
          <Route path="reports/*" element={<Reports me={me} book={book} can={can} setBook={setBook} reloadMe={reloadMe} />} />
          <Route path="setup/*" element={<Setup me={me} book={book} can={can} setBook={setBook} reloadMe={reloadMe} />} />
          <Route path="vouchers/:id/print" element={<VoucherPrint me={me} book={book} can={can} setBook={setBook} reloadMe={reloadMe} />} />
        </Routes>
      </Suspense>
    </div>
  );
}
