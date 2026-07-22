// Artwork — two approvals, one lock. Both ticks = locked, automatically.
// No parallel approval systems, no dead reject buttons.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, ShadeAge, StatusBadge, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Lock, LockOpen, Hammer, FolderOpen, Link2, GitBranch, Pencil } from 'lucide-react';
import WorkflowControls, { BulkWorkflowControls, DangerZone } from '../components/WorkflowControls.jsx';
import { GangChip, GangCellParts } from '../components/Gang.jsx';

// Tooling readiness chip — the Artwork ↔ Tooling Hub bridge. Emerald = gate
// satisfied; amber = registered tooling not ready yet; red = die missing.
function ToolingChip({ line }) {
  const nav = useNavigate();
  const d = line.tooling || [];
  const gaps = d.filter(x => (x.hard ? x.status !== 'ready' : x.status === 'not_ready'));
  const cls = line.tooling_ready ? 'bg-emerald-100 text-emerald-700'
    : gaps.some(g => g.hard && g.status === 'missing') ? 'bg-red-100 text-red-700'
    : 'bg-amber-100 text-amber-700';
  const label = line.tooling_ready ? '✓ Ready'
    : gaps.map(g => `${g.label} ${g.status === 'missing' ? 'missing' : g.zone === 'making' ? 'at maker' : 'not ready'}`).join(' · ');
  return (
    <button title="Open in Tooling Hub"
      onClick={e => { e.stopPropagation(); nav(`/tooling?product=${line.product_id}`); }}
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-75 ${cls}`}>
      {label}
    </button>
  );
}

function Toggle({ on, onClick, label }) {
  return (
    <button onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
        on ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
      {on ? '✓ ' : ''}{label}
    </button>
  );
}

// Total sheets = ceil(qty / ups) + wastage — the same figure the cut plan
// prints. 150 mirrors the server DEFAULT_WASTAGE_SHEETS fallback.
const WASTAGE_SHEETS = 150;
const sheetsFor = l => Math.ceil((Number(l.qty) || 0) / Math.max(1, Number(l.ups) || 1)) + (l.wastage_sheets ?? WASTAGE_SHEETS);
// 4-colour process reads as CMYK; anything else is N-colour spot.
const colorMode = l => (l.colors === 4 ? 'CMYK' : l.colors ? `${l.colors}C` : null);
// Sub-line of the Board & sheet cell — imposition · die. (Board, GSM and
// sheet size already live inside board_name, e.g. "Saffire · 300 GSM · 23 x 36".)
const imposition = l => [l.ups ? `${l.ups}-up` : null, l.die_number ? `Die ${l.die_number}` : null].filter(Boolean).join(' · ');

// Identity codes on the Artwork form that follow the master-update philosophy.
const CODE_LABELS = {
  party_artwork_code: 'Artwork Code',
  output_number: 'Output Number',
  shade_card_number: 'Shade Card Number',
  shade_card_date: 'Shade Card Date',
};

// The Tooling Hub sections a locked artwork can be fanned into; each lands in
// that section's triage. Block is a foil/emboss tool, so it is only offered
// when the line actually embosses or foils (see PushToToolingModal).
const TOOL_SECTIONS = [
  { key: 'plate', label: 'Plate', hint: 'Printing plates → plate triage' },
  { key: 'die', label: 'Die', hint: 'Cutting die → die triage' },
  { key: 'shade_card', label: 'Shade Card', hint: 'Approved shade → shade-card triage' },
  { key: 'block', label: 'Block', hint: 'Foil / emboss block → block triage', needsEmboss: true },
];

// Fan-out popup — Artwork's only job is to push into the selected sections'
// triage; the send-decision then happens inside each section of the hub.
function PushToToolingModal({ line, onClose, onDone }) {
  const toast = useToast();
  const statusOf = fam => (line?.tooling || []).find(t => t.family === fam);
  // Block only applies when the job embosses or foils/leafs — hide it otherwise.
  const embossable = !!line?.emboss || !!line?.leafing;
  const sections = TOOL_SECTIONS.filter(s => !s.needsEmboss || embossable);
  // Default: every applicable section ticked. Plate / Die / Shade Card are always
  // in view; Block is only in `sections` when there is real block work, so ticking
  // all visible sections keeps Block on only for emboss/foil jobs.
  const [sel, setSel] = useState(() => Object.fromEntries(
    sections.map(s => [s.key, true])));
  const [busy, setBusy] = useState(false);
  const chosen = sections.filter(s => sel[s.key]).map(s => s.key);

  const push = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const res = await api.post('/tools/push', { product_id: line.product_id, families: chosen });
      if (res.created?.length) toast.success(`Pushed to ${res.created.map(c => c.label).join(', ')} triage`);
      if (res.skipped?.length) toast.info(`Already in hub: ${res.skipped.join(', ')}`);
      if (!res.created?.length && !res.skipped?.length) toast.info('Nothing to push');
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e.message || 'Push failed');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!line} onClose={onClose}
      title={line ? `Push to Tooling Hub — ${line.product_name}` : ''}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={push} disabled={busy || !chosen.length}>
          {busy ? 'Pushing…' : `Push ${chosen.length || ''} to triage`.replace('  ', ' ')}
        </Button>
      </>}>
      {line && (
        <div className="space-y-3">
          <div className="ci-summary-panel text-xs">
            Sends this product into each selected section&rsquo;s <b>triage (Incoming)</b> at once — the send-decision is then made inside the section.
          </div>
          <div className="space-y-1.5">
            {sections.map(s => {
              const d = statusOf(s.key);
              const inHub = d && d.status !== 'missing';
              return (
                <label key={s.key}
                  className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-3 transition-colors ${
                    sel[s.key] ? 'border-[#0A84FF]/40 bg-[#0A84FF]/[0.06]' : 'border-white/70 bg-white/60 hover:bg-white/80'}`}>
                  <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                    checked={!!sel[s.key]} onChange={e => setSel(v => ({ ...v, [s.key]: e.target.checked }))} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#1D1D1F]">{s.label}</span>
                      {d && <span className="rounded-full bg-[#1D1D1F]/[0.06] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">Required</span>}
                    </div>
                    <div className="text-xs text-gray-400">{s.hint}</div>
                  </div>
                  {inHub && <span className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">In hub{d.zone ? ` · ${fmt.title(d.zone)}` : ''}</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function Artwork() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [tab, setTab] = useState('open');
  const [editing, setEditing] = useState(null);
  const [gangOpen, setGangOpen] = useState(null); // gang_run_id of the gang whose unified panel is open
  const [pushLine, setPushLine] = useState(null);
  const [form, setForm] = useState({ customer_ok: false, qa_ok: false, planned_date: '', qty: '', notes: '', party_artwork_code: '', output_number: '', shade_card_number: '', shade_card_date: '' });
  const [syncPrompt, setSyncPrompt] = useState(null); // { changed } — "Sync Master?" for artwork/output/shade codes
  const load = () => api.get('/artwork').then(setLines);
  useEffect(() => { load(); }, []);
  const canApprove = ['admin', 'planner', 'qc'].includes(auth.user?.role);
  const canEditPlanning = ['admin', 'planner'].includes(auth.user?.role);
  const canPush = ['admin', 'planner'].includes(auth.user?.role);
  const open = lines.filter(l => !l.artwork_locked);
  const locked = lines.filter(l => l.artwork_locked && !l.jc_number);
  const completed = lines.filter(l => !!l.jc_number); // pushed to a job card
  const shown = { open, locked, completed, all: lines }[tab] || open;
  // A gang travels as ONE product up to die cutting — so it must READ as one
  // row here too. Collapse every member line of a gang into a single synthetic
  // row carrying `_gang` (all members, in id order); everything else is a plain
  // line. Mirrors the Planning queue so a gang looks identical plan-to-artwork.
  const displayRows = (() => {
    const out = [];
    const seen = new Set();
    for (const r of shown) {
      if (!r.gang_run_id) { out.push(r); continue; }
      if (seen.has(r.gang_run_id)) continue;
      seen.add(r.gang_run_id);
      const members = shown.filter(x => x.gang_run_id === r.gang_run_id);
      out.push(members.length > 1 ? { ...r, id: `gang-${r.gang_run_id}`, _gang: members } : r);
    }
    return out;
  })();
  const selectedLines = lines.filter(l => selectedIds.includes(l.id));
  // Members of the gang whose unified panel is open (live from `lines` so it
  // reflects every approval as it lands). Null panel → empty.
  const gangMembers = gangOpen ? lines.filter(l => l.gang_run_id === gangOpen) : [];
  const clearSelection = () => setSelectedIds([]);
  // Selecting a gang row selects every member line — they act as one job.
  const rowIds = row => (row._gang ? row._gang.map(m => m.id) : [row.id]);
  const toggleSelected = (row, checked) => setSelectedIds(ids => checked
    ? [...new Set([...ids, ...rowIds(row)])]
    : ids.filter(id => !rowIds(row).includes(id)));
  const toggleAll = (visibleRows, checked) => {
    const visibleIds = visibleRows.flatMap(rowIds);
    setSelectedIds(ids => checked
      ? [...new Set([...ids, ...visibleIds])]
      : ids.filter(id => !visibleIds.includes(id)));
  };

  const setApproval = async (l, patch) => {
    const updated = await api.post(`/order-lines/${l.id}/artwork`, patch);
    if (updated.artwork_locked && !l.artwork_locked) toast.success(`Artwork locked for ${l.product_name}`);
    load();
  };
  // Approve/clear ONE flag across EVERY carton in a gang at once — the gang is one
  // product, so it approves and locks as one. Each carton keeps its other flag.
  const setGangApproval = async (members, key, val) => {
    for (const m of members) {
      await api.post(`/order-lines/${m.id}/artwork`, {
        customer_ok: key === 'customer' ? val : !!m.artwork_customer_ok,
        qa_ok: key === 'qa' ? val : !!m.artwork_qa_ok,
      });
    }
    toast.success(`${key === 'customer' ? 'Customer' : 'QA shade/text'} ${val ? 'approved' : 'cleared'} for all ${members.length} cartons`);
    load();
  };
  // Push EVERY carton's tooling to the hub in one go (each product keeps its own
  // plate/die/shade; a block only where that carton embosses or foils).
  const pushGangTooling = async members => {
    let n = 0;
    for (const m of members) {
      const fams = ['plate', 'die', 'shade_card', ...(m.emboss || m.leafing ? ['block'] : [])];
      const res = await api.post('/tools/push', { product_id: m.product_id, families: fams }).catch(() => null);
      n += res?.created?.length || 0;
    }
    toast.success(n ? `Pushed ${members.length} cartons' tooling to triage` : 'Tooling already in the hub');
    load();
  };
  // Send the gang to the Job Card station as ONE parent card. createJobCardForLine
  // is gang-aware, so a single call on any member builds the shared parent JC.
  const gangToJobCard = async members => {
    await api.post(`/workflow/order-lines/${members[0].id}`, { action: 'push_to_job_card', destinations: [] });
    toast.success(`${members[0].gang_number} sent to Job Card as one gang`);
    setGangOpen(null); load();
  };
  const openForm = line => {
    if (line._gang) { setGangOpen(line.gang_run_id); return; } // gang → unified panel
    setEditing(line);
    setForm({
      customer_ok: !!line.artwork_customer_ok,
      qa_ok: !!line.artwork_qa_ok,
      planned_date: line.planned_date ? String(line.planned_date).slice(0, 10) : '',
      qty: line.qty ?? '',
      notes: line.notes || '',
      party_artwork_code: line.party_artwork_code || '',
      output_number: line.output_number || '',
      shade_card_number: line.shade_card_number || '',
      shade_card_date: line.shade_card_date ? String(line.shade_card_date).slice(0, 10) : '',
    });
  };
  // Which identity codes were edited away from what the line currently carries.
  const changedCodes = () => {
    if (!editing) return {};
    const out = {};
    for (const f of ['party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date']) {
      const cur = f === 'shade_card_date' ? String(editing[f] ?? '').slice(0, 10) : String(editing[f] ?? '');
      if (String(form[f] ?? '').trim() !== cur) out[f] = String(form[f] ?? '').trim();
    }
    return out;
  };
  // Save intercepts an Artwork Code / Output Number change with the master-sync
  // question — update the Carton Product Master, or keep it for this job only.
  const saveForm = () => {
    if (!editing) return;
    const changed = canEditPlanning ? changedCodes() : {};
    if (Object.keys(changed).length) { setSyncPrompt({ changed }); return; }
    doSave({});
  };
  const doSave = async ({ spec, update_master }) => {
    const updated = await api.put(`/order-lines/${editing.id}/artwork`, {
      customer_ok: form.customer_ok,
      qa_ok: form.qa_ok,
      ...(canEditPlanning ? { planned_date: form.planned_date, qty: form.qty, notes: form.notes } : {}),
      ...(spec && Object.keys(spec).length ? { spec, update_master: !!update_master } : {}),
    });
    if (updated.artwork_locked && !editing.artwork_locked) toast.success(`Artwork locked for ${editing.product_name}`);
    else if (spec && Object.keys(spec).length) {
      toast.success(update_master ? 'Saved — Carton Product Master updated' : 'Saved for this job only');
    }
    setSyncPrompt(null);
    setEditing(null);
    load();
  };

  return (
    <div>
      <PageHeader title="Artwork Queue" subtitle="Customer approval + QA shade/text approval → artwork locks automatically" />
      <Tabs active={tab} onChange={k => { setTab(k); clearSelection(); }} tabs={[
        { key: 'open', label: 'Awaiting Approval', count: open.length },
        { key: 'locked', label: 'Locked', count: locked.length },
        { key: 'completed', label: 'Completed', count: completed.length },
        { key: 'all', label: 'All', count: lines.length },
      ]} />
      <BulkWorkflowControls lines={selectedLines} context="artwork" onDone={load} onClear={clearSelection} />
      <DataTable searchable
        selectable
        selectedIds={selectedIds}
        onToggleRow={toggleSelected}
        onToggleAll={toggleAll}
        onRowClick={openForm}
        groupBy={l => (l._gang ? `gang-${l.gang_run_id}` : null)}
        columns={[
          { key: 'customer_name', label: 'Client / PO',
            export: l => l._gang
              ? `${l.gang_number}: ${[...new Set(l._gang.map(m => `${m.po_number} (${m.customer_name})`))].join(' | ')}`
              : `${l.customer_name} · PO ${l.po_number}`,
            render: l => l._gang
            ? (() => {
                const pos = [...new Set(l._gang.map(m => m.po_number))];
                const custs = [...new Set(l._gang.map(m => m.customer_name))];
                return (
                  <div className="max-w-[180px]">
                    <GangChip number={l.gang_number} />
                    <div className="mt-1 font-semibold leading-snug text-[#1D1D1F]">{custs.join(' · ')}</div>
                    <div className="mt-0.5 text-xs text-gray-500">PO {pos.join(' · ')}</div>
                    <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-500">{l._gang.length} cartons · one run</div>
                  </div>
                );
              })()
            : (
            <div className="max-w-[160px]">
              <div className="font-semibold leading-snug text-[#1D1D1F] line-clamp-2">{l.customer_name}</div>
              <div className="mt-0.5 text-xs text-gray-500">PO {l.po_number}</div>
            </div>) },
          { key: 'product_name', label: 'Product',
            export: l => l._gang ? l._gang.map(m => m.product_name).join(' + ') : `${l.product_name} (${l.product_code} · ${l.colors} colours${colorMode(l) ? ` · ${colorMode(l)}` : ''}${l.size ? ` · ${l.size}` : ''})`,
            render: l => l._gang
            ? <GangCellParts members={l._gang}
                total={<span className="font-semibold normal-case text-violet-600">together until die cutting</span>}
                render={m => (
                  <div className="min-w-0">
                    <div className="max-w-[240px] truncate text-sm font-semibold text-gray-900" title={m.product_name}>{m.product_name}</div>
                    <div className="max-w-[240px] truncate text-xs text-gray-400">{m.product_code} · {m.colors} colours{m.special !== 'none' ? ` · ${fmt.title(m.special)}` : ''}</div>
                  </div>
                )} />
            : (
            <div className="max-w-[300px]">
              <div className="font-medium leading-snug line-clamp-2">{l.product_name}</div>
              <div className="mt-0.5 text-xs text-gray-400">{l.product_code} · {l.colors} colours{l.special !== 'none' ? ` · ${fmt.title(l.special)}` : ''}{l.size ? ` · ${l.size}` : ''}</div>
              {colorMode(l) && <span className="mt-1.5 inline-block rounded-full bg-[#1D1D1F]/[0.06] px-2 py-0.5 text-[10px] font-bold tracking-[0.08em] text-[#6E6E73]">{colorMode(l)}</span>}
            </div>) },
          { key: 'board_name', label: 'Board & sheet', sortable: false,
            export: l => [(l._gang ? l._gang[0] : l).board_name || (l.gsm ? `${l.gsm} gsm` : '—'), imposition(l._gang ? l._gang[0] : l)].filter(Boolean).join(' · '),
            render: l => {
              const b = l._gang ? l._gang[0] : l; // a gang shares ONE mother sheet
              return (
                <div className="max-w-[220px]">
                  <div className="font-medium leading-snug text-[#1D1D1F]">{b.board_name || (b.gsm ? `${b.gsm} gsm` : '—')}</div>
                  <div className="mt-0.5 text-xs text-gray-400">{l._gang ? `${b.child_l && b.child_w ? `${b.child_l}×${b.child_w}" child · ` : ''}shared sheet` : (imposition(l) || '—')}</div>
                </div>);
            } },
          { key: 'qty', label: 'Quantity', align: 'right',
            sortValue: l => (l._gang ? l._gang.reduce((s, m) => s + (Number(m.qty) || 0), 0) : Number(l.qty) || 0),
            export: l => l._gang
              ? `${fmt.num(l._gang.reduce((s, m) => s + (+m.qty || 0), 0))} (gang)`
              : `${fmt.num(l.qty)} (${fmt.num(sheetsFor(l))} sheets)`,
            render: l => l._gang
              ? <GangCellParts members={l._gang} align="right"
                  total={fmt.num(l._gang.reduce((s, m) => s + (+m.qty || 0), 0))}
                  render={m => (
                    <div>
                      <div className="font-bold tabular-nums text-[#1D1D1F]">{fmt.num(m.qty)}</div>
                      <div className="text-xs tabular-nums text-gray-400">{fmt.num(sheetsFor(m))} sheets</div>
                    </div>)} />
              : (
            <div>
              <div className="font-bold tabular-nums text-[#1D1D1F]">{fmt.num(l.qty)}</div>
              <div className="text-xs tabular-nums text-gray-400">{fmt.num(sheetsFor(l))} sheets</div>
            </div>) },
          { key: 'planned_date', label: 'Planned', render: l => {
            if (!l._gang) return fmt.date(l.planned_date);
            const dates = [...new Set(l._gang.map(m => m.planned_date).filter(Boolean))].sort();
            return <div><div>{fmt.date(dates[0])}</div>{dates.length > 1 && <div className="text-[10px] font-semibold text-amber-600">earliest of {dates.length}</div>}</div>;
          } },
          { key: 'appr', label: 'Approvals', sortable: false, render: l => {
            if (l._gang) {
              // The gang is ONE product — approve every carton together.
              const allC = l._gang.every(m => m.artwork_customer_ok);
              const allQ = l._gang.every(m => m.artwork_qa_ok);
              return (
                <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                  <Toggle on={allC} label="Customer" onClick={() => canApprove && setGangApproval(l._gang, 'customer', !allC)} />
                  <Toggle on={allQ} label="QA Shade/Text" onClick={() => canApprove && setGangApproval(l._gang, 'qa', !allQ)} />
                </div>);
            }
            return (
              <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                <Toggle on={!!l.artwork_customer_ok} label="Customer" onClick={() => canApprove && setApproval(l, { customer_ok: !l.artwork_customer_ok, qa_ok: !!l.artwork_qa_ok })} />
                <Toggle on={!!l.artwork_qa_ok} label="QA Shade/Text" onClick={() => canApprove && setApproval(l, { customer_ok: !!l.artwork_customer_ok, qa_ok: !l.artwork_qa_ok })} />
              </div>);
          } },
          { key: 'lock', label: 'Lock', sortable: false, render: l => {
            const cell = m => m.artwork_locked
              ? <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600"><Lock size={13} /> Locked</span>
              : <span className="inline-flex items-center gap-1 text-xs text-gray-400"><LockOpen size={13} /> Open</span>;
            if (!l._gang) return cell(l);
            const n = l._gang.filter(m => m.artwork_locked).length;
            return <GangCellParts members={l._gang}
              total={<span className={n === l._gang.length ? 'text-emerald-600' : 'text-violet-700'}>{n}/{l._gang.length} locked</span>}
              render={cell} />;
          } },
          { key: 'tooling', label: 'Tooling', sortable: false, render: l => {
            const cell = m => <div className="flex items-center gap-1.5"><ToolingChip line={m} /></div>;
            return l._gang ? <GangCellParts members={l._gang} render={cell} /> : cell(l);
          } },
          { key: 'status', label: 'Status', render: l => {
            const cell = m => <StatusBadge status={m.status} />;
            return l._gang ? <GangCellParts members={l._gang} render={cell} /> : cell(l);
          } },
          { key: 'workflow', label: '', sortable: false, render: l => {
            // A gang carries ONE unified action set — open its panel (approve,
            // push tooling, send to job card) instead of per-carton buttons.
            if (l._gang) return (
              <div className="flex items-center justify-end" onClick={e => e.stopPropagation()}>
                <Button size="sm" variant="secondary" onClick={() => setGangOpen(l.gang_run_id)}>
                  <FolderOpen size={13} /> Open
                </Button>
              </div>);
            return (
              <div className="flex items-center justify-end gap-1.5">
                {canPush && (
                  <button title="Push to Tooling Hub"
                    onClick={e => { e.stopPropagation(); setPushLine(l); }}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[#D7E0EC] bg-white text-[#596E64] shadow-none transition-colors hover:border-[#BFCBC4] hover:bg-[#F5F8F6] hover:text-[#31443D]">
                    <Hammer size={14} />
                  </button>
                )}
                <WorkflowControls line={l} context="artwork" onDone={load} iconOnly />
                <DangerZone line={l} onDone={load} asMenu />
              </div>);
          } },
        ]}
        rows={displayRows} empty={{
          open: 'No artwork waiting for approval',
          locked: 'No locked artwork yet',
          completed: 'Nothing pushed to a job card yet',
          all: 'No artwork in the queue',
        }[tab]}
        exportName="Artwork Queue"
        exportSubtitle="Customer + QA approvals and lock status"
        exportMeta={() => [`Tab: ${({ open: 'Awaiting Approval', locked: 'Locked', completed: 'Completed', all: 'All' })[tab]}`]} />

      <Modal open={!!editing} onClose={() => { if (!syncPrompt) setEditing(null); }} title={editing ? `Artwork Form — ${editing.po_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Close</Button>
          {(canApprove || canEditPlanning) && <Button onClick={saveForm}>Save Changes</Button>}
        </>}>
        {editing && (
          <div className="space-y-4">
            <div className="ci-summary-panel text-xs">
              {editing.product_name} · {editing.customer_name} · {editing.product_code}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Artwork approvals</span><span>{editing.artwork_locked ? 'Locked' : 'Open'}</span></div>
              <div className="flex flex-wrap gap-2">
                <Toggle on={form.customer_ok} label="Customer" onClick={() => canApprove && setForm(f => ({ ...f, customer_ok: !f.customer_ok }))} />
                <Toggle on={form.qa_ok} label="QA Shade/Text" onClick={() => canApprove && setForm(f => ({ ...f, qa_ok: !f.qa_ok }))} />
              </div>
            </section>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Codes &amp; technical spec</span><span>mapped to the Carton Product Master</span></div>
              <div className="ci-form-grid">
                <Field label="Artwork Code" hint="Party artwork code — auto-populates single-run plans">
                  <Input value={form.party_artwork_code} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, party_artwork_code: e.target.value })} />
                </Field>
                <Field label="Output Number" hint="Print set number for this carton">
                  <Input value={form.output_number} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, output_number: e.target.value })} />
                </Field>
                <Field label="Shade Card Number" hint="Approved shade card — syncs to the master on save">
                  <Input value={form.shade_card_number} disabled={!canEditPlanning} placeholder="e.g. SC-2041"
                    onChange={e => setForm({ ...form, shade_card_number: e.target.value })} />
                </Field>
                <Field label="Shade Card Date" hint="drives the 1-year shade-card age">
                  <div>
                    <Input type="date" value={form.shade_card_date} disabled={!canEditPlanning}
                      onChange={e => setForm({ ...form, shade_card_date: e.target.value })} />
                    {form.shade_card_date && <div className="mt-1"><ShadeAge date={form.shade_card_date} /></div>}
                  </div>
                </Field>
                <Field label="Internal Carton Code">
                  <Input value={editing.internal_carton_code || '—'} disabled readOnly />
                </Field>
                <Field label="Carton (Product) Code">
                  <Input value={editing.product_code || '—'} disabled readOnly />
                </Field>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[['Board', editing.board_name || '—'], ['GSM', editing.gsm || '—'],
                  ['Size', editing.size || '—'], ['Colours', editing.colors != null ? `${editing.colors}c${colorMode(editing) ? ` · ${colorMode(editing)}` : ''}` : '—'],
                  ['Ups', editing.ups || '—'], ['Die', editing.die_number || '—'],
                  ['Coating', editing.coating && editing.coating !== 'none' ? fmt.title(editing.coating) : '—'],
                  ['Print Sheet', editing.child_l && editing.child_w ? `${editing.child_l}×${editing.child_w}"` : '—']]
                  .map(([k, v]) => (
                    <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                      <div className="truncate text-sm font-bold text-slate-800" title={String(v)}>{v}</div>
                    </div>))}
              </div>
            </section>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Line details</span><span>{fmt.title(editing.status)}</span></div>
              <div className="ci-form-grid">
                <Field label="Planned Date">
                  <Input type="date" value={form.planned_date || ''} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, planned_date: e.target.value })} />
                </Field>
                <Field label="Quantity">
                  <Input type="number" min="1" value={form.qty} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, qty: e.target.value })} />
                </Field>
                <Field label="Product">
                  <Input value={editing.product_name || ''} disabled readOnly />
                </Field>
                <Field label="Customer">
                  <Input value={editing.customer_name || ''} disabled readOnly />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Notes">
                  <Textarea value={form.notes} disabled={!canEditPlanning}
                    onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Artwork or planning notes" />
                </Field>
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* ── Gang Artwork panel — the gang is ONE product: one approval, one
             action set, opened from the unified row. Per-carton code editing
             opens the same single form on top. ── */}
      <Modal open={!!gangOpen && gangMembers.length > 0} onClose={() => setGangOpen(null)} wide
        title={gangMembers[0] ? `Gang Artwork — ${gangMembers[0].gang_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setGangOpen(null)}>Close</Button>
          {canPush && <Button variant="secondary" onClick={() => pushGangTooling(gangMembers)}><Hammer size={14} /> Push all to Tooling</Button>}
          {canEditPlanning && gangMembers.length > 0 && gangMembers.every(m => m.artwork_locked) && !gangMembers.some(m => m.jc_number) &&
            <Button onClick={() => gangToJobCard(gangMembers)}><GitBranch size={14} /> Send gang to Job Card</Button>}
        </>}>
        {gangMembers.length > 0 && (() => {
          const anchor = gangMembers[0];
          const allC = gangMembers.every(m => m.artwork_customer_ok);
          const allQ = gangMembers.every(m => m.artwork_qa_ok);
          const lockedN = gangMembers.filter(m => m.artwork_locked).length;
          return (
            <div className="space-y-4">
              <div className="ci-summary-panel flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1 font-bold text-violet-700"><Link2 size={13} /> {anchor.gang_number}</span>
                <span>{gangMembers.length} cartons · one press run</span>
                <span className="text-slate-300">·</span>
                <span className="font-semibold text-slate-700">{anchor.board_name}</span>
                {anchor.child_l && anchor.child_w && <span className="text-slate-400">child {anchor.child_l}×{anchor.child_w}"</span>}
              </div>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Approve the whole gang</span><span>{lockedN}/{gangMembers.length} locked</span></div>
                <div className="flex flex-wrap items-center gap-2">
                  <Toggle on={allC} label="Customer" onClick={() => canApprove && setGangApproval(gangMembers, 'customer', !allC)} />
                  <Toggle on={allQ} label="QA Shade/Text" onClick={() => canApprove && setGangApproval(gangMembers, 'qa', !allQ)} />
                  <span className={`ml-auto inline-flex items-center gap-1 text-xs font-bold ${lockedN === gangMembers.length ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {lockedN === gangMembers.length ? <><Lock size={13} /> All artwork locked</> : <><LockOpen size={13} /> {gangMembers.length - lockedN} still open</>}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">Both ticks lock every carton's artwork at once — the gang prints as one sheet.</p>
              </section>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Cartons on this sheet</span><span>edit each carton's codes</span></div>
                <div className="divide-y divide-slate-100">
                  {gangMembers.map(m => (
                    <div key={m.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-800">{m.product_name}</div>
                        <div className="truncate text-[11px] text-slate-400">{m.product_code}{m.party_artwork_code ? ` · AW ${m.party_artwork_code}` : ''}{m.shade_card_number ? ` · SC ${m.shade_card_number}` : ''}</div>
                      </div>
                      {m.artwork_locked
                        ? <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-emerald-600"><Lock size={12} /> Locked</span>
                        : <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-400"><LockOpen size={12} /> Open</span>}
                      <ToolingChip line={m} />
                      {canEditPlanning && <Button size="sm" variant="secondary" onClick={() => setEditing(m)}><Pencil size={12} /> Codes</Button>}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          );
        })()}
      </Modal>

      {/* ── Sync Master? — artwork code / output number changed ── */}
      <Modal open={!!syncPrompt} onClose={() => setSyncPrompt(null)} title="Sync Master?"
        footer={<>
          <Button variant="secondary" onClick={() => setSyncPrompt(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => doSave({ spec: syncPrompt.changed, update_master: false })}>This Job Only</Button>
          <Button onClick={() => doSave({ spec: syncPrompt.changed, update_master: true })}>Update Carton Product Master</Button>
        </>}>
        {syncPrompt && editing && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Do you want to update this updated {Object.keys(syncPrompt.changed).map(k => CODE_LABELS[k] || fmt.title(k)).join(' and ')} back
              to the <b>Carton Product Master</b> for future auto-population? (Applicable for single items — gang runs
              generate their own set numbers.)
            </p>
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              {Object.entries(syncPrompt.changed).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="shrink-0 font-semibold text-slate-700">{CODE_LABELS[k] || fmt.title(k)}</span>
                  <span className="min-w-0 text-right text-slate-500">
                    <span className="line-through">{(k === 'shade_card_date' ? String(editing[k] ?? '').slice(0, 10) : editing[k]) || '—'}</span>
                    <span className="mx-1.5 text-slate-300">→</span>
                    <b className="text-slate-900">{v || '—'}</b>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              “This Job Only” keeps the change as a job-level override; the master keeps its current codes.
            </p>
          </div>
        )}
      </Modal>

      <PushToToolingModal key={pushLine?.id ?? 'none'} line={pushLine} onClose={() => setPushLine(null)} onDone={load} />
    </div>
  );
}
