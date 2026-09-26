// Kit Studio — carton sizing, layouts and draft kits for the Fluence kit master.
//
// The studio is a self-contained page (client/public/kit-studio/index.html) with
// its own look and its own drawers, so it runs in an iframe here rather than
// being rebuilt in React. This component is its host:
//
//   • every read and write the studio makes comes through `window.__kitStudioHost`
//     and goes out with the signed-in user's session via api.js — the studio page
//     never touches the ERP sign-in itself;
//   • the realtime feed tells it when a kit, an inner product or the Fluence
//     master changed, so one person's save reaches everyone's open studio.
//
// Who may do what is the server's call (routes/kitstudio.js): everyone who can
// open the Fluence master may look; Planning roles may edit.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, auth } from '../api.js';
import { subscribeToDbChanges } from '../lib/realtime.js';

// The tables the studio's view is built from.
const STUDIO_TABLES = [
  'kit_studio_kits', 'kit_studio_products', 'kit_studio_drafts', 'kit_studio_settings',
  'fluence_kits', 'fluence_kit_components', 'fluence_inner_products',
];
const SEGMENT = { kits: 'kits', products: 'products', drafts: 'drafts', settings: 'settings' };

function pathFor(coll, id) {
  const seg = SEGMENT[coll];
  if (!seg) throw new Error(`Kit Studio: unknown collection ${coll}`);
  return `/kit-studio/${seg}/${encodeURIComponent(id)}`;
}

export default function KitStudio() {
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(720);
  const frameBox = useRef(null);

  useEffect(() => {
    const listeners = new Set();
    const host = {
      request(op, p = {}) {
        return send(op, p).catch(e => {
          // A refusal the studio explains itself: hand it over as it is, so the
          // message appears once, inside the studio, next to what was refused.
          if (e?.data?.code === 'KIT_STUDIO_REFUSED') throw Object.assign(new Error(e.message), { status: e.status });
          throw e;
        });
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      user: auth.user,
    };
    function send(op, p) {
      switch (op) {
        case 'state': return api.get('/kit-studio/state');
        case 'put': return api.put(pathFor(p.coll, p.id), { doc: p.doc, base_version: p.base_version });
        case 'del': return api.del(pathFor(p.coll, p.id), { base_version: p.base_version });
        case 'erpSize': return api.post(`/kit-studio/kits/${encodeURIComponent(p.id)}/erp-size`, {});
        default: return Promise.reject(new Error(`Kit Studio: unknown request ${op}`));
      }
    }
    window.__kitStudioHost = host;
    const stop = subscribeToDbChanges(() => {
      for (const fn of listeners) { try { fn(); } catch { /* the studio reloads on its own poll */ } }
    }, { tables: STUDIO_TABLES });
    setReady(true);
    return () => {
      stop();
      if (window.__kitStudioHost === host) delete window.__kitStudioHost;
    };
  }, []);

  // The studio scrolls inside its own frame (its drawers are pinned to the
  // frame's viewport), so the frame fills the screen below the ERP's header.
  useLayoutEffect(() => {
    const fit = () => {
      const top = frameBox.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(520, Math.round(window.innerHeight - Math.max(0, top) - 12)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ready]);

  return (
    <div ref={frameBox} className="-mx-1 overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-sm sm:-mx-0">
      {ready && (
        <iframe
          src="/kit-studio/index.html"
          title="Kit Studio"
          className="block w-full border-0"
          style={{ height }}
        />
      )}
    </div>
  );
}
