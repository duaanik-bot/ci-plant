// Kit Studio ↔ CI ERP bridge.
//
// Kit Studio was built as a stand-alone page that keeps its data through a small
// document API (`claude.use('db' | 'user' | 'downloads')`). Inside the ERP that
// API is provided here, over the ERP's own REST endpoints (/api/kit-studio/*),
// so the studio's code runs unchanged.
//
// This page never holds the ERP sign-in itself. It runs inside an <iframe> on
// /kit-studio (client/src/pages/KitStudio.jsx), and every request goes through
// the host page's `window.__kitStudioHost`, which calls the API with the signed-in
// user's session and tells us when the database changes (realtime feed).
(function () {
  'use strict';
  var host = null;
  try { if (window.parent && window.parent !== window) host = window.parent.__kitStudioHost || null; } catch (e) { host = null; }
  window.kitStudioInErp = !!host;
  if (!host) return; // opened on its own: the studio shows its "open it from the ERP" banner

  // Everything that crosses from the host page is copied into this page's realm.
  var clone = function (x) { return x == null ? x : JSON.parse(JSON.stringify(x)); };
  var COLLS = ['kits', 'products', 'drafts'];
  var state = { kits: new Map(), products: new Map(), drafts: new Map(), settings: null };
  var sigs = {};
  var listeners = { kits: new Set(), products: new Set(), drafts: new Set(), settings: new Set() };
  var me = { name: null, can_edit: false };
  var loaded = false, loading = null, again = false;

  function notice(msg) {
    try { window.dispatchEvent(new CustomEvent('kitstudio:notice', { detail: String(msg) })); } catch (e) { /* ignore */ }
  }
  function querySnap(coll) {
    var docs = [];
    state[coll].forEach(function (v, id) { docs.push({ id: id, exists: true, data: function () { return clone(v.data); } }); });
    return { docs: docs, size: docs.length, empty: !docs.length };
  }
  function docSnap() {
    var s = state.settings;
    return { id: 'main', exists: !!s, data: function () { return s ? clone(s.data) : undefined; } };
  }
  function fire(coll) {
    var snap = coll === 'settings' ? docSnap() : querySnap(coll);
    listeners[coll].forEach(function (l) { try { l.next(snap); } catch (e) { console.error(e); } });
  }
  function apply(s) {
    if (s.me) me = s.me;
    COLLS.forEach(function (coll) {
      var list = s[coll] || [];
      var sig = JSON.stringify(list);
      if (sig === sigs[coll]) return;
      sigs[coll] = sig;
      var m = new Map();
      list.forEach(function (d) { m.set(d.id, { version: d.version, data: d.data }); });
      state[coll] = m;
      fire(coll);
    });
    var ssig = JSON.stringify(s.settings || null);
    if (ssig !== sigs.settings) {
      sigs.settings = ssig;
      state.settings = s.settings ? { version: s.settings.version, data: s.settings.data } : null;
      fire('settings');
    }
  }
  function refresh() {
    if (loading) { again = true; return loading; }
    loading = host.request('state').then(function (s) {
      apply(clone(s));
      loaded = true;
    }, function (err) {
      Object.keys(listeners).forEach(function (coll) {
        listeners[coll].forEach(function (l) { if (l.error) try { l.error(err); } catch (e) { /* ignore */ } });
      });
    }).then(function () {
      loading = null;
      if (again) { again = false; refresh(); }
    });
    return loading;
  }

  // A refusal from the ERP, in the shape the studio already understands:
  // `invalid_argument` = no edit rights, anything else = a message to show.
  function studioError(err) {
    var e = new Error((err && err.message) || 'The ERP did not save that.');
    if (err && err.status === 403) e.code = 'invalid_argument';
    e.status = err && err.status;
    return e;
  }
  function versionOf(coll, id) {
    if (coll === 'settings') return state.settings ? state.settings.version : 0;
    var d = state[coll].get(id);
    return d ? d.version : 0;
  }
  function stamp(body) {
    var d = clone(body) || {};
    d.updatedAt = new Date().toISOString();
    d.updatedBy = me.name;
    return d;
  }

  function saveDoc(coll, id, body) {
    return host.request('put', { coll: coll, id: id, doc: clone(body), base_version: versionOf(coll, id) }).then(function (res) {
      res = clone(res) || {};
      if (coll === 'settings') {
        state.settings = { version: res.version, data: stamp(body) };
        sigs.settings = null; fire('settings');
      } else {
        var composed = res.doc && res.doc.id === id ? res.doc : null;
        state[coll].set(id, composed ? { version: composed.version, data: composed.data } : { version: res.version, data: stamp(body) });
        sigs[coll] = null; fire(coll);
      }
      if (res.erp === 'filled') notice('Saved — the ERP product size is now ' + res.erpSize + '.');
      else if (res.erp === 'differs') notice('Saved. The ERP product still says ' + res.erpSize + ' — open the kit and use “Use this size in ERP” if the studio size is the right one.');
      if (res.masterChanged && res.masterChanged.length) notice('Saved — the Fluence master is updated too.');
      refresh();
      return undefined;
    }, function (err) {
      if (err && err.status === 409) refresh();
      throw studioError(err);
    });
  }
  function deleteDoc(coll, id) {
    return host.request('del', { coll: coll, id: id, base_version: versionOf(coll, id) }).then(function () {
      state[coll].delete(id); sigs[coll] = null; fire(coll); refresh();
    }, function (err) {
      if (err && err.status === 409) refresh();
      throw studioError(err);
    });
  }

  function listen(coll, next, error) {
    var l = { next: next, error: error };
    listeners[coll].add(l);
    if (loaded) Promise.resolve().then(function () { if (listeners[coll].has(l)) l.next(coll === 'settings' ? docSnap() : querySnap(coll)); });
    else refresh();
    return function () { listeners[coll].delete(l); };
  }
  function docRef(coll, id) {
    return {
      id: id,
      set: function (body) { return saveDoc(coll, id, body); },
      delete: function () { return deleteDoc(coll, id); },
      onSnapshot: function (next, error) {
        if (coll !== 'settings') throw new Error('Only the settings document can be watched on its own.');
        return listen('settings', next, error);
      },
    };
  }
  function collectionRef(coll) {
    if (!listeners[coll] || coll === 'settings') throw new Error('Unknown collection ' + coll);
    var ref = {
      limit: function () { return ref; },
      doc: function (id) { return docRef(coll, id); },
      onSnapshot: function (next, error) { return listen(coll, next, error); },
    };
    return ref;
  }

  var db = {
    collection: collectionRef,
    doc: function (path) {
      var p = String(path).split('/');
      if (p[0] === 'settings' && p[1] === 'main') return docRef('settings', 'main');
      return docRef(p[0], p[1]);
    },
  };
  var user = {
    canEdit: function () { return (loaded ? Promise.resolve() : refresh()).then(function () { return !!me.can_edit; }); },
    id: function () { return (loaded ? Promise.resolve() : refresh()).then(function () { return me.name; }); },
    // The studio records people by name inside the ERP, so a name reads as itself.
    profiles: function (ids) {
      var out = {};
      (ids || []).forEach(function (i) { out[i] = { name: String(i) }; });
      return Promise.resolve(out);
    },
  };
  var downloads = {
    save: function (o) {
      var name = String((o && o.filename) || 'kit-studio');
      var data = o && o.data;
      var type = /\.pdf$/i.test(name) ? 'application/pdf' : /\.csv$/i.test(name) ? 'text/csv;charset=utf-8' : 'application/octet-stream';
      var blob = data instanceof Blob ? data : new Blob([data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : String(data == null ? '' : data)], { type: type });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return Promise.resolve();
    },
  };

  window.claude = {
    use: function (name) {
      if (name === 'db') return Promise.resolve(db);
      if (name === 'user') return Promise.resolve(user);
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);
    },
  };

  // ERP-only actions the studio page offers inside the ERP. Each one that changes
  // a kit answers with the kit as the ERP now composes it, which lands at once.
  function landed(id) {
    return function (res) {
      res = clone(res) || {};
      if (res.doc && res.doc.id === id) { state.kits.set(id, { version: res.doc.version, data: res.doc.data }); sigs.kits = null; fire('kits'); }
      refresh();
      return res;
    };
  }
  function refused(err) { if (err && err.status === 409) refresh(); throw studioError(err); }
  window.kitStudioErp = {
    useErpSize: function (id) { return host.request('erpSize', { id: id }).then(landed(id), refused); },
    // May this person create or link the kit's carton in the product master?
    canKeepProducts: function () { return !!me.can_keep_products; },
    // What the product-master dialog shows: next codes, likely products, and the
    // print spec of the kits offered to copy from (product ids).
    erpOptions: function (id, refs) {
      return host.request('erpOptions', { id: id, refs: (refs || []).filter(Boolean).join(',') }).then(clone, refused);
    },
    createProduct: function (id, body) { return host.request('erpProduct', { id: id, body: clone(body) }).then(landed(id), refused); },
    linkProduct: function (id, body) { return host.request('erpLink', { id: id, body: clone(body) }).then(landed(id), refused); },
    unlinkProduct: function (id) { return host.request('erpUnlink', { id: id }).then(landed(id), refused); },
    // What is in a kit and its prescription are edited in the ERP's one-table
    // editor (the Fluence drawer), opened over the studio by the host page. Its
    // save reaches this page through the realtime feed like any other.
    openKitEditor: typeof host.openKitEditor === 'function'
      ? function (fluenceKitId, opts) { host.openKitEditor(Number(fluenceKitId), { edit: !!(opts && opts.edit) }); }
      : null,
  };

  // Another person's save, or an edit in the Fluence Master, reaches this page
  // through the host's realtime subscription. A slow poll backs it up.
  if (typeof host.subscribe === 'function') host.subscribe(function () { refresh(); });
  setInterval(function () { if (!document.hidden) refresh(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && loaded) refresh(); });
})();
