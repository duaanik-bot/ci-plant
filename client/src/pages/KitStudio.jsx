// Kit Studio — carton sizing, layouts and draft kits for the Fluence kit master.
//
// The studio is a self-contained page (client/public/kit-studio-app/index.html) with
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
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, auth } from '../api.js';
import { subscribeToDbChanges } from '../lib/realtime.js';

// What is in a kit and its prescription are edited in the one-table editor of
// the Fluence drawer; the studio hands a kit over to it (openKitEditor).
const FluenceDrawer = lazy(() => import('../components/fluence/FluenceDrawer.jsx'));

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
  const [kitEditor, setKitEditor] = useState(null);   // { kitId, edit } — the Fluence drawer over the studio
  const frameBox = useRef(null);
  const listenersRef = useRef(null);

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
      openKitEditor(kitId, opts = {}) {
        if (Number.isInteger(kitId) && kitId > 0) setKitEditor({ kitId, edit: Boolean(opts.edit) });
      },
      user: auth.user,
    };
    listenersRef.current = listeners;
    function send(op, p) {
      const kit = `/kit-studio/kits/${encodeURIComponent(p.id)}`;
      switch (op) {
        case 'state': return api.get('/kit-studio/state');
        case 'put': return api.put(pathFor(p.coll, p.id), { doc: p.doc, base_version: p.base_version });
        case 'del': return api.del(pathFor(p.coll, p.id), { base_version: p.base_version });
        case 'erpSize': return api.post(`${kit}/erp-size`, {});
        // The kit's carton in the product master (routes/kitstudio.js).
        case 'erpOptions': return api.get(`${kit}/erp-options${p.refs ? `?refs=${encodeURIComponent(p.refs)}` : ''}`);
        case 'erpProduct': return api.post(`${kit}/erp-product`, p.body);
        case 'erpLink': return api.post(`${kit}/erp-link`, p.body);
        case 'erpUnlink': return api.post(`${kit}/erp-unlink`, {});
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
  // On a phone the tab bar (.ci-dock) is pinned over the bottom of the page, so
  // the frame stops above it — the studio's own toasts and footers stay in view.
  useLayoutEffect(() => {
    const fit = () => {
      const top = frameBox.current?.getBoundingClientRect().top ?? 0;
      const dock = document.querySelector('.ci-dock')?.getBoundingClientRect().height ?? 0;
      setHeight(Math.max(520, Math.round(window.innerHeight - Math.max(0, top) - dock - 12)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ready]);

  // A save in the editor reaches the studio at once, not only on the next feed tick.
  const studioRefresh = () => { for (const fn of listenersRef.current || []) { try { fn(); } catch { /* the poll catches up */ } } };

  // No frame of its own: the studio page is transparent and wears the ERP's
  // theme, so it sits on the same canvas as every other module.
  return (
    <div ref={frameBox} className="-mx-1 sm:-mx-0">
      {ready && (
        <iframe
          src="/kit-studio-app/index.html"
          title="Kit Studio"
          className="block w-full border-0 bg-transparent"
          style={{ height, colorScheme: 'light' }}
        />
      )}
      {kitEditor && (
        <Suspense fallback={null}>
          <FluenceDrawer key={kitEditor.kitId} kitId={kitEditor.kitId} startEditing={kitEditor.edit} context="kit_studio"
            onSaved={studioRefresh} onClose={() => { setKitEditor(null); studioRefresh(); }} />
        </Suspense>
      )}
    </div>
  );
}
