// An artwork mail thread as a person reads it (owner, 18 Nov 2026: "This whole mail, the whole trail, the thread, should
// all be visible so that we actually know what is going on"). Gmail's thread (format=full) → its messages, oldest first:
// who wrote, to whom, when, whether it is ours (the company mailbox), the text (plain text preferred, HTML made
// readable, the quoted earlier mail kept apart), and the attachments with the ids to open them. Drafts are not part of
// the trail. Pure, so it is tested on its own; routes/artwork-register.js reads the thread and serves this.
const MAX_TEXT = 20000;

const headerOf = (payload, name) => (payload?.headers || []).filter(h => String(h.name).toLowerCase() === name).map(h => h.value).join(', ');
const decode = data => { try { return Buffer.from(String(data || ''), 'base64url').toString('utf8'); } catch { return ''; } };

// HTML → readable text: line breaks kept, tags and styles gone, the common entities decoded.
function htmlText(html) {
  return String(html)
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Every part, depth first.
function* parts(p) {
  if (!p) return;
  yield p;
  for (const c of p.parts || []) yield* parts(c);
}

// Where the earlier mail starts in a reply ("On … wrote:", Outlook's "From: … Sent:", a line of ">"): kept apart.
const QUOTE = /^(On .{4,200} wrote:\s*$|-{2,} ?Original Message ?-{2,}|From: .+\r?\n(Sent|Date): .+|>.*)/m;

export function threadMessages(thread, { own }) {
  const me = String(own || '').toLowerCase();
  const out = [];
  for (const m of thread?.messages || []) {
    if ((m.labelIds || []).includes('DRAFT')) continue;
    const all = [...parts(m.payload)];
    const plain = all.find(x => x.mimeType === 'text/plain' && !x.filename && x.body?.data);
    const html = all.find(x => x.mimeType === 'text/html' && !x.filename && x.body?.data);
    let text = plain ? decode(plain.body.data).replace(/\r\n/g, '\n') : html ? htmlText(decode(html.body.data)) : '';
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    let quoted = '';
    const q = QUOTE.exec(text);
    if (q && q.index > 0) { quoted = text.slice(q.index).trim(); text = text.slice(0, q.index).trim(); }
    const cut = text.length > MAX_TEXT;
    if (cut) text = `${text.slice(0, MAX_TEXT)}…`;
    if (quoted.length > MAX_TEXT) quoted = `${quoted.slice(0, MAX_TEXT)}…`;
    const from = headerOf(m.payload, 'from');
    const t = Number(m.internalDate);
    out.push({
      id: m.id, at: t > 0 ? new Date(t).toISOString() : null,
      from, to: headerOf(m.payload, 'to'), cc: headerOf(m.payload, 'cc'), subject: headerOf(m.payload, 'subject'),
      ours: (m.labelIds || []).includes('SENT') || (!!me && from.toLowerCase().includes(me)),
      text, quoted, cut,
      attachments: all.filter(x => x.filename && x.body?.attachmentId).map(x => ({
        name: x.filename, mime: x.mimeType || 'application/octet-stream', size: Number(x.body.size) || null, attachment_id: x.body.attachmentId, message_id: m.id,
      })),
    });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
