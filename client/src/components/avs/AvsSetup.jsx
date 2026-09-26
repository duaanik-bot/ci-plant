// Artwork Verification → Setup (admin): the two links, set up once.
//
//   Drive link  — a Google Apps Script web app deployed from the Google account
//                 that owns the AVS folder. CI Plant puts uploaded photos into
//                 the folder through it, and Claude reads and files through it.
//   Claude link — the API trigger of the AVS routine at claude.ai/code/routines.
//                 Verify calls it; Claude checks the queue in its own cloud
//                 session, with the Mac and the Claude app closed.
//
// The secret the Drive link checks is made by CI Plant and written into the
// script shown here; the Claude token is kept on the server and never shown again.
import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Copy, ExternalLink, HardDrive, XCircle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Modal, useToast } from '../ui.jsx';
import { DRIVE_BRIDGE_URL_RE, ROUTINE_FIRE_URL_RE } from '../../lib/avs.js';
import DRIVE_LINK_SOURCE from '../../lib/avs-robot/drive-link.gs?raw';
import ROUTINE_PROMPT from '../../lib/avs-robot/routine-prompt.md?raw';
import ROUTINE_SETUP from '../../lib/avs-robot/routine-setup.sh?raw';

const ALLOWED_DOMAINS = 'script.google.com\nscript.googleusercontent.com';

function CopyButton({ text, label }) {
  const toast = useToast();
  return (
    <Button size="sm" variant="secondary" repeatable onClick={async () => {
      try { await navigator.clipboard.writeText(text); toast.success(`${label} copied`); }
      catch { toast.error('Copy did not work here. Select the text and copy it by hand.'); }
    }}>
      <span className="inline-flex items-center gap-1"><Copy size={12} /> {label}</span>
    </Button>
  );
}

function Linked({ on }) {
  return on
    ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 size={13} /> Linked</span>
    : <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400"><XCircle size={13} /> Not linked</span>;
}

export default function AvsSetup({ open, onClose, onChanged }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [driveUrl, setDriveUrl] = useState('');
  const [fireUrl, setFireUrl] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(null);

  const load = () => api.get('/avs/setup').then(c => {
    setCfg(c); setDriveUrl(c.drive_bridge_url || ''); setFireUrl(c.routine_fire_url || ''); setToken('');
  }).catch(() => {});
  useEffect(() => { if (open) load(); }, [open]);

  const script = cfg ? DRIVE_LINK_SOURCE.replace("'__SECRET__'", `'${cfg.drive_bridge_secret}'`) : '';

  const save = async body => {
    await api.put('/avs/setup', body);
    toast.success('Saved');
    await load(); onChanged?.();
  };
  const test = async what => {
    setTesting(what);
    try {
      if (what === 'drive') {
        const out = await api.post('/avs/setup/test-drive', {});
        toast.success(`Drive link works: folder ${out.root?.name || '?'}`);
      } else {
        const out = await api.post('/avs/setup/test-claude', {});
        toast.success('Claude started a test run');
        if (out.session_url) window.open(out.session_url, '_blank', 'noopener');
      }
    } catch { /* api.js said why */ } finally { setTesting(null); }
  };
  const newSecret = async () => {
    await api.post('/avs/setup/new-secret', {});
    toast.info('New secret made: copy the script again and paste it into Apps Script, then Deploy > Manage deployments > Edit > New version.');
    load();
  };

  const drivePattern = driveUrl === '' || DRIVE_BRIDGE_URL_RE.test(driveUrl.trim());
  const firePattern = fireUrl === '' || ROUTINE_FIRE_URL_RE.test(fireUrl.trim());
  const inputCls = 'h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs focus:border-[#0071F0] focus:outline-none';

  return (
    <Modal open={open} onClose={onClose} wide title="AVS setup: Google Drive and Claude"
      footer={<Button variant="secondary" repeatable onClick={onClose}>Close</Button>}>
      {!cfg && <div className="p-4 text-sm text-slate-400">Loading…</div>}
      {cfg && (
        <div className="space-y-6 text-sm text-slate-700">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-semibold text-slate-900"><HardDrive size={16} /> 1. Drive link — puts the photos in your AVS folder</h3>
              <Linked on={cfg.linked?.drive} />
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-[13px]">
              <li>Signed in to Google as the owner of the AVS folder (dua.anik@gmail.com), open{' '}
                <a className="text-[#0071F0] underline" href="https://script.google.com/home/projects/create" target="_blank" rel="noreferrer">script.google.com → New project</a>.</li>
              <li>Delete what is in the editor, paste the script (button below), and press Save.</li>
              <li>On the left, next to Services, press <b>+</b>, pick <b>Drive API</b>, press Add.</li>
              <li>Deploy → New deployment → gear icon → <b>Web app</b>. Execute as: <b>Me</b>. Who has access: <b>Anyone</b>. Deploy, then Authorize access (Google says the app is unverified: it is your own script — Advanced → Go to project → Allow).</li>
              <li>Copy the <b>Web app URL</b> (ends in /exec), paste it here, Save, then Test.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={script} label="Copy script" />
              <Button size="sm" variant="ghost" onClick={newSecret}>Make a new secret</Button>
            </div>
            <input value={driveUrl} onChange={e => setDriveUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" className={inputCls} />
            {!drivePattern && <p className="text-xs text-red-600">That is not a Web app URL: it starts with https://script.google.com/macros/s/ and ends in /exec.</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!drivePattern || driveUrl.trim() === (cfg.drive_bridge_url || '')}
                onClick={() => save({ drive_bridge_url: driveUrl.trim() })}>Save</Button>
              <Button size="sm" variant="secondary" disabled={!cfg.drive_bridge_url || testing === 'drive'} onClick={() => test('drive')}>Test</Button>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Bot size={16} /> 2. Claude link — Verify starts the check</h3>
              <Linked on={cfg.linked?.claude} />
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-[13px]">
              <li>Open <a className="text-[#0071F0] underline" href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">claude.ai/code/routines <ExternalLink size={11} className="inline" /></a> (your Claude account) → <b>New routine</b>. Name: <b>AVS check</b>.</li>
              <li>Instructions: paste the prompt (button below). Pick the strongest model in the list.</li>
              <li>Environment: create one called <b>AVS</b>. Network access: <b>Custom</b>, tick “Also include default list”, and add the two domains (button below). Setup script: paste the setup script (button below).</li>
              <li>Connectors: keep <b>Supabase</b>, <b>Gmail</b> and <b>Google Drive</b>; remove the rest. No repository is needed; if the form insists on one, pick <b>duaanik-bot/ci-plant</b> (the check never changes it).</li>
              <li>Trigger: <b>API</b>. Save the routine, open it again → the API trigger → copy the URL, press <b>Generate token</b> and copy the token (it is shown once).</li>
              <li>Paste both here and Save. <b>Send a test</b> starts one Claude run that only checks its connections (it counts as one routine run).</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={ROUTINE_PROMPT} label="Copy prompt" />
              <CopyButton text={ALLOWED_DOMAINS} label="Copy domains" />
              <CopyButton text={ROUTINE_SETUP} label="Copy setup script" />
            </div>
            <input value={fireUrl} onChange={e => setFireUrl(e.target.value)} placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire" className={inputCls} />
            {!firePattern && <p className="text-xs text-red-600">That is not a routine API URL.</p>}
            <input value={token} onChange={e => setToken(e.target.value)} type="password" autoComplete="off"
              placeholder={cfg.routine_token_hint ? `Token saved (${cfg.routine_token_hint}) — paste a new one to replace it` : 'Token from Generate token'}
              className={inputCls} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!firePattern || (fireUrl.trim() === (cfg.routine_fire_url || '') && !token.trim())}
                onClick={() => save({ routine_fire_url: fireUrl.trim(), routine_token: token.trim() })}>Save</Button>
              <Button size="sm" variant="secondary" disabled={!cfg.linked?.claude || testing === 'claude'} onClick={() => test('claude')}>Send a test</Button>
            </div>
            <p className="text-[11px] text-slate-500">Claude runs on your account and your Claude usage; each Verify (or test) is one routine run. One run checks every set waiting.</p>
          </section>
        </div>
      )}
    </Modal>
  );
}
