// FinanceAccess: Setup's fifth tab (spec §8.1, §10). Props: { me, book, reloadMe }.
//
// Who may do what in the books: one grant per login per book, carrying the roles it holds there (Viewer, Accountant, Approver, Admin;
// they combine) and whether it may export. It is the admin's screen (capability `admin`), and it lists the grants on every book this
// login administers, not only the one the shell is on.
//   GET    /finance/access          { grants, users }: the grants, and the logins that can be given one
//   POST   /finance/access          { user_id, book_id, roles, can_export }: gives a grant, or changes the one the login has
//   DELETE /finance/access/:id      takes a grant away
//
// Ruling R31: can_export is ALWAYS sent, as the boolean the box shows (finGrantBody). An omitted flag keeps the stored value on an update,
// so a form that left it out would say one thing and do another. The box is ticked for a NEW grant, and for a grant that exists it
// starts from what is stored (finGrantFormOf), so widening someone's roles can never switch an export back on by accident. Choosing a
// login and a book that already have a grant loads that grant into the form and says it is changing one.
//
// Ruling R60: a grant or a revoke for the logged-in user's OWN id changes the books and roles the shell hands every page, so the shell is
// asked again (reloadMe) once the write has gone through: the tabs, the buttons and the book switch follow at once, without a reload. If
// that grant takes away this very screen, the page falls back to a tab the login still has. The shell is asked BEFORE the list is
// reloaded, and the list is not reloaded at all for a login that no longer administers the book: GET /finance/access answers 403 to a
// login that administers nothing, and api.js would toast that refusal on top of the success.
//
// The server will not take the last Admin from a book (FIN_LAST_ADMIN): that refusal is toasted and the dialog stays for the person.
// Revoking a grant that is already gone is a 403 or a 404 (it depends on which lost the race); the list is reloaded and shows it gone, so
// the dialog closes. A write that gets no answer is said (useNoAnswer), and the save buttons are the shared Button, so a press is one press.
// A refusal that names the login or the book (a login switched off since its grant was made) is drawn on the form whether the grant is
// new or being changed.
//
// The search is the screen's own (controlled), so a search that finds nothing says "No grants match this search." and never "No one has
// access to these books yet." (finSearchEmpty, as the Task 16 lists do).
import { useDeferredValue, useMemo, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Checkbox, ConfirmDialog, DataTable, Field, Modal, rowMatches, Select, useToast } from '../ui.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { Chip, FieldError } from './SetupParts.jsx';
import useFormWrite from './useFormWrite.js';
import useNoAnswer from './useNoAnswer.js';
import useReport from './useReport.js';
import { finSearchEmpty } from '../../lib/finance/page.js';
import {
  FIN_ROLE_CHOICES, finAdminBooks, finAdministers, finGrantBody, finGrantFormOf, finGrantProblem, finIsOwnGrant, finRoleLabel, finSetupEmpty,
} from '../../lib/finance/setup.js';

// The name of a book the login holds, for a grant's row (a grant is only ever listed on a book this login administers).
const bookNameOf = (books, id) => books.find(b => b.id === id)?.name ?? `Book #${id}`;

// Give a grant, or change one. `grant` is the row being changed (the login and the book are then fixed), or null for a new one.
function GrantForm({ me, book, grant, grants, users, adminBooks, onClose, onSaved, onFailed }) {
  const toast = useToast();
  const { problems, attempt } = useFormWrite();
  const start = grant
    ? { userId: grant.user_id, bookId: grant.book_id }
    : { userId: null, bookId: adminBooks.some(b => b.id === book.id) ? book.id : adminBooks[0]?.id ?? null };
  const [userId, setUserId] = useState(start.userId);
  const [bookId, setBookId] = useState(start.bookId);
  // roles, canExport and `existing` (the grant already stored for this login and book, or null), always for the pair chosen
  const [state, setState] = useState(() => finGrantFormOf(grants, start.userId, start.bookId));
  const choose = (nextUser, nextBook) => { setUserId(nextUser); setBookId(nextBook); setState(finGrantFormOf(grants, nextUser, nextBook)); };

  const toggle = role => setState(s => ({ ...s, roles: s.roles.includes(role) ? s.roles.filter(r => r !== role) : [...s.roles, role] }));
  const problem = finGrantProblem({ userId, bookId, roles: state.roles });
  const person = users.find(u => u.id === userId);
  const bookOf = adminBooks.find(b => b.id === bookId);
  const own = finIsOwnGrant({ user_id: userId }, me);

  const save = async () => {
    const body = finGrantBody({ userId, bookId, roles: state.roles, canExport: state.canExport });
    const done = await attempt(() => api.post('/finance/access', body), { onFail: onFailed });
    if (!done) return;
    toast.success(state.existing ? 'Access changed' : 'Access given');
    await onSaved(body);
  };

  const userOptions = users.map(u => ({ value: u.id, label: u.name, hint: u.email, search: `${u.name} ${u.email}` }));
  const bookOptions = adminBooks.map(b => ({ value: b.id, label: b.name, search: `${b.name} ${b.code}` }));

  return (
    <Modal open onClose={onClose} title={grant ? 'Change access' : 'Give access'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={problem !== ''}>{state.existing ? 'Save access' : 'Give access'}</Button>
      </>}>
      <div className="space-y-3">
        {grant ? (
          <div>
            <p className="text-sm text-[#1D1D1F]">
              <span className="font-semibold">{grant.user_name ?? 'A deleted login'}</span>
              <span className="text-slate-500"> · {bookOf?.name ?? `Book #${grant.book_id}`}</span>
            </p>
            {/* A login switched off since the grant was made is refused here (user_id): the sentence is drawn, not only toasted. */}
            <FieldError>{problems.user_id}</FieldError>
            <FieldError>{problems.book_id}</FieldError>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Login" required>
              <Select options={userOptions} value={userId ?? ''} placeholder="Choose a login…"
                renderOption={item => (
                  <span className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{item.label}</span>
                    <span className="shrink-0 truncate text-[11px] font-normal text-slate-400">{item.hint}</span>
                  </span>
                )}
                onChange={e => choose(e.target.value === '' ? null : Number(e.target.value), bookId)} />
              <FieldError>{problems.user_id}</FieldError>
            </Field>
            <Field label="Book" required>
              <Select options={bookOptions} value={bookId ?? ''} placeholder="Choose a book…"
                onChange={e => choose(userId, e.target.value === '' ? null : Number(e.target.value))} />
              <FieldError>{problems.book_id}</FieldError>
            </Field>
          </div>
        )}

        {state.existing && !grant && (
          <p className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2 text-sm text-slate-600">
            {person?.name ?? 'This login'} already has access to {bookOf?.name ?? 'this book'} ({state.existing.roles.map(finRoleLabel).join(', ')}).
            What you save here replaces it.
          </p>
        )}

        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-slate-600">Roles <span className="text-brand-500">*</span> <span className="font-normal text-gray-400">(they combine)</span></legend>
          <div className="space-y-2">
            {FIN_ROLE_CHOICES.map(role => (
              <div key={role.key}>
                <Checkbox label={role.label} checked={state.roles.includes(role.key)} onChange={() => toggle(role.key)} />
                <span className="ml-6 block text-xs text-slate-500">{role.hint}</span>
              </div>
            ))}
          </div>
          <FieldError>{problems.roles}</FieldError>
        </fieldset>

        <div>
          <Checkbox label="May export reports to Excel and PDF" checked={state.canExport} onChange={e => setState(s => ({ ...s, canExport: e.target.checked }))} />
          <FieldError>{problems.can_export}</FieldError>
        </div>

        {own && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This is your own access. If you take Admin away you will no longer see this screen.
          </p>
        )}
        <FieldError>{problems.form}</FieldError>
      </div>
    </Modal>
  );
}

export default function FinanceAccess({ me, book, reloadMe }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const { data, failed, reload } = useReport('/finance/access');
  const [form, setForm] = useState(null);           // {} to give a grant, { grant } to change one
  const [revoking, setRevoking] = useState(null);   // a grant
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);

  const grants = data?.grants ?? null;
  const users = data?.users ?? [];
  const adminBooks = useMemo(() => finAdminBooks(me.books), [me.books]);
  const rows = useMemo(() => (grants ?? []).map(g => ({ ...g, book_name: bookNameOf(me.books, g.book_id) })), [grants, me.books]);
  // The search is held here and not by the table, so the empty line below can tell a search that hid every row from a book with none.
  const shown = useMemo(() => (query.trim() ? rows.filter(r => rowMatches(r, query)) : rows), [rows, query]);

  // Ruling R60: a grant for this login's own id changes what the shell hands every page. Asked after the write has gone through, and the
  // shell's new answer comes back; null when the grant is somebody else's, or when the shell could not be asked, in which case the person
  // is told, because the screen would otherwise go on offering what the login may no longer do.
  const followShell = async grant => {
    if (!finIsOwnGrant(grant, me)) return null;
    try { return await reloadMe(); } catch {
      toast.error('Your own access changed, but it could not be refreshed here. Reload the page to see what you may do now.');
      return null;
    }
  };

  // What follows a write that went through. For the login's own grant the shell is asked FIRST: the list is the admin's (GET
  // /finance/access answers 403 to a login that administers nothing), so a login that has just taken its own Admin away must not be sent
  // to read it, and the screen is going: its tab goes with the right. Otherwise the list is reloaded, to show what was written.
  const afterWrite = async grant => {
    const answer = await followShell(grant);
    if (answer && !finAdministers(answer.books, book.id)) return;
    await reload();
  };

  const saved = async body => {
    setForm(null);
    await afterWrite({ user_id: body.user_id });
  };

  const revoke = async () => {
    const grant = revoking;
    try {
      await api.del(`/finance/access/${grant.id}`);
    } catch (e) {
      noAnswer(e);
      await reload();
      // Already revoked by someone else: a 403 when it was seen first, a 404 when the two raced. The reload shows it gone.
      if (e?.status === 403 || e?.status === 404) return;
      throw e;
    }
    toast.success('Access taken away');
    await afterWrite(grant);
  };

  const columns = [
    { key: 'user_name', label: 'Login', card: 'title', sortValue: r => (r.user_name ?? '').toLowerCase(), render: r => (
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 font-semibold">
          {r.user_name ?? <span className="text-gray-400">A deleted login</span>}
          {finIsOwnGrant(r, me) && <Chip tone="info">You</Chip>}
        </div>
        {r.email && <div className="truncate text-xs text-slate-500">{r.email}</div>}
      </div>) },
    { key: 'book_name', label: 'Book', card: 'subtitle', render: r => r.book_name },
    { key: 'roles', label: 'Roles', sortable: false, card: 'metric', export: r => r.roles.map(finRoleLabel).join(', '), render: r => (
      <div className="flex flex-wrap gap-1">{r.roles.map(role => <Chip key={role} tone={role === 'admin' ? 'info' : 'neutral'}>{finRoleLabel(role)}</Chip>)}</div>) },
    { key: 'can_export', label: 'Export', card: 'metric', sortValue: r => (r.can_export ? 1 : 0), render: r => (r.can_export ? <Chip tone="good">Can export</Chip> : <Chip tone="muted">No export</Chip>) },
    { key: '_actions', label: '', card: 'actions', render: r => (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setForm({ grant: r })}>Change</Button>
        <Button size="sm" variant="ghost" onClick={() => setRevoking(r)}>Revoke</Button>
      </div>) },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-xs text-slate-500">
          Who can do what, on each book you administer. A login can hold several roles on a book, and none on another. Roles take effect at once.
        </p>
        <Button onClick={() => setForm({})} disabled={!data || adminBooks.length === 0}><UserPlus size={14} /> Give access</Button>
      </div>

      <LoadNotice failed={failed} shown={Boolean(grants)} what="the access list" onRetry={reload} />

      <DataTable rows={shown} columns={columns} getRowId={r => r.id} serialNumber={false} defaultSort={{ key: 'book_name', dir: 'asc' }}
        searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search a login or a book…"
        empty={finSetupEmpty({
          known: Boolean(grants), failed,
          none: finSearchEmpty({ searching: query.trim() !== '', total: rows.length, none: 'No one has access to these books yet.', noun: 'grants' }),
        })} />

      {form && (
        <GrantForm me={me} book={book} grant={form.grant ?? null} grants={grants ?? []} users={users} adminBooks={adminBooks}
          onClose={() => setForm(null)} onFailed={reload} onSaved={saved} />
      )}
      <ConfirmDialog open={revoking != null} onClose={() => setRevoking(null)} onConfirm={revoke} danger confirmLabel="Take away access"
        title={revoking ? `Take away ${revoking.user_name ?? 'this login'}'s access?` : ''}
        message={revoking
          ? `${revoking.user_name ?? 'This login'} will no longer see ${bookNameOf(me.books, revoking.book_id)}.${finIsOwnGrant(revoking, me) ? ' This is your own access: you will lose it at once.' : ''}`
          : ''} />
    </div>
  );
}
