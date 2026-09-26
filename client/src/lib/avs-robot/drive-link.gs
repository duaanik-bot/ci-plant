/**
 * CI Plant - AVS Drive link (a Google Apps Script web app).
 *
 * Lets CI Plant (motionci.in) and the Claude AVS routine read and add files in
 * the AVS folder of this Google Drive: CI Plant puts the uploaded carton photos
 * there, and Claude reads them and files the report next to them. It never
 * deletes anything. Text files (the register, the logs, JSON) may be updated in
 * place and PDFs replaced; Drive keeps every earlier version in the file's
 * version history.
 *
 * Set up once, signed in to Google as the owner of the AVS folder:
 *  1. Open script.google.com and press New project. Replace everything in the
 *     editor with this code and press Save.
 *  2. On the left, next to Services, press +, choose Drive API, press Add.
 *  3. Press Deploy > New deployment. Gear icon > Web app.
 *     Execute as: Me.   Who has access: Anyone.   Press Deploy.
 *     Press Authorize access and choose your account. Google says the app is
 *     not verified (it is your own script): Advanced > Go to project > Allow.
 *  4. Copy the Web app URL (it ends in /exec) into CI Plant >
 *     Artwork Verification > Setup > Drive link, press Save, then Test.
 *
 * The secret below comes from CI Plant. Anyone who has it can read and add
 * files in the AVS folder, so keep this code to yourself.
 */
var SECRET = '__SECRET__';
var ROOT_PATH = '01_Business/AVS'; // the AVS folder, counted from My Drive

function doGet() {
  return out_({ ok: true, service: 'CI Plant AVS Drive link' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_({ ok: false, error: 'The request is not JSON' });
  }
  if (!req.secret || req.secret !== SECRET) return out_({ ok: false, error: 'Wrong secret' });
  var lock = null;
  try {
    if (req.op === 'ping') return out_({ ok: true, root: folderInfo_(root_()) });
    if (req.op === 'list') return out_({ ok: true, entries: list_(folderAt_(req.path, false)) });
    if (req.op === 'get') return out_(get_(req));
    // Writes one at a time, so two photos arriving together never make two
    // folders of the same name.
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    if (req.op === 'put') return out_(put_(req));
    if (req.op === 'move') return out_(move_(req));
    if (req.op === 'mkdir') return out_({ ok: true, folder: folderInfo_(folderAt_(req.path, true)) });
    return out_({ ok: false, error: 'Unknown op: ' + req.op });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

var ROOT_ = null;
function root_() {
  if (ROOT_) return ROOT_;
  var f = DriveApp.getRootFolder();
  var names = ROOT_PATH.split('/');
  for (var i = 0; i < names.length; i++) {
    if (!names[i]) continue;
    var next = childFolder_(f, names[i]);
    if (!next) throw new Error('AVS folder not found at My Drive/' + ROOT_PATH);
    f = next;
  }
  ROOT_ = f;
  return f;
}

function parts_(path) {
  var raw = String(path || '').split('/');
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var p = raw[i].trim();
    if (!p) continue;
    if (p === '.' || p === '..') throw new Error('Bad path: ' + path);
    out.push(p);
  }
  return out;
}

function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    var c = it.next();
    if (!c.isTrashed()) return c;
  }
  return null;
}

function childFile_(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

function folderAt_(path, create) {
  var f = root_();
  var names = parts_(path);
  for (var i = 0; i < names.length; i++) {
    var next = childFolder_(f, names[i]);
    if (!next) {
      if (!create) throw new Error('Folder not found: ' + path);
      next = f.createFolder(names[i]);
    }
    f = next;
  }
  return f;
}

function fileAt_(path) {
  var names = parts_(path);
  var name = names.pop();
  var f = name ? childFile_(folderAt_(names.join('/'), false), name) : null;
  if (!f) throw new Error('File not found: ' + path);
  return f;
}

// A file named by its id must sit inside the AVS folder; nothing else is served.
function inside_(file) {
  var rootId = root_().getId();
  var queue = [];
  var ps = file.getParents();
  while (ps.hasNext()) queue.push(ps.next());
  var seen = {};
  for (var n = 0; n < 200 && queue.length; n++) {
    var p = queue.shift();
    var id = p.getId();
    if (id === rootId) return true;
    if (seen[id]) continue;
    seen[id] = true;
    var up = p.getParents();
    while (up.hasNext()) queue.push(up.next());
  }
  return false;
}

function byId_(id) {
  var f = DriveApp.getFileById(String(id));
  if (!inside_(f)) throw new Error('That file is not in the AVS folder');
  return f;
}

function fileInfo_(f) {
  return {
    id: f.getId(), name: f.getName(), folder: false, mime: f.getMimeType(), size: f.getSize(),
    modified: f.getLastUpdated().toISOString(), url: f.getUrl()
  };
}

function folderInfo_(d) {
  return { id: d.getId(), name: d.getName(), folder: true, modified: d.getLastUpdated().toISOString(), url: d.getUrl() };
}

function list_(folder) {
  var out = [];
  var ds = folder.getFolders();
  while (ds.hasNext()) {
    var d = ds.next();
    if (!d.isTrashed()) out.push(folderInfo_(d));
  }
  var fs = folder.getFiles();
  while (fs.hasNext()) {
    var f = fs.next();
    if (!f.isTrashed()) out.push(fileInfo_(f));
  }
  return out;
}

function get_(req) {
  var f = req.id ? byId_(req.id) : fileAt_(req.path);
  var res = fileInfo_(f);
  var blob = f.getBlob();
  if (req.as === 'text') res.text = blob.getDataAsString('UTF-8');
  else res.base64 = Utilities.base64Encode(blob.getBytes());
  res.ok = true;
  return res;
}

// put: a new file, or (replace: true) new content for a file of that name.
//   text:   { path, name, text, mime?, replace? }  register, logs, JSON
//   base64: { path, name, base64, mime?, replace?, ifExists? }  photos, PDFs
// ifExists 'reuse' answers with the file already there instead of refusing.
function put_(req) {
  if (!req.name) throw new Error('name is missing');
  var folder = folderAt_(req.path, true);
  var existing = childFile_(folder, req.name);
  var res;
  if (req.text !== undefined && req.text !== null) {
    if (existing) {
      if (!req.replace) throw new Error('A file with this name is already there: ' + req.name);
      existing.setContent(String(req.text));
      res = fileInfo_(existing);
      res.replaced = true;
    } else {
      res = fileInfo_(folder.createFile(req.name, String(req.text), req.mime || 'text/plain'));
      res.created = true;
    }
  } else {
    if (!req.base64) throw new Error('text or base64 is missing');
    var blob = Utilities.newBlob(Utilities.base64Decode(req.base64), req.mime || 'application/octet-stream', req.name);
    if (existing && req.ifExists === 'reuse') {
      res = fileInfo_(existing);
      res.existed = true;
    } else if (existing && req.replace) {
      // Same file, new content: needs the Drive API service (setup step 2).
      if (typeof Drive === 'undefined') {
        throw new Error('Replacing ' + req.name + ' needs the Drive API service: Services > + > Drive API > Add');
      }
      Drive.Files.update({}, existing.getId(), blob);
      res = fileInfo_(DriveApp.getFileById(existing.getId()));
      res.replaced = true;
    } else if (existing) {
      throw new Error('A file with this name is already there: ' + req.name);
    } else {
      res = fileInfo_(folder.createFile(blob));
      res.created = true;
    }
  }
  res.parent = folderInfo_(folder);
  res.ok = true;
  return res;
}

function move_(req) {
  var f = req.id ? byId_(req.id) : fileAt_(req.path);
  var to = folderAt_(req.to, true);
  f.moveTo(to);
  var res = fileInfo_(f);
  res.parent = folderInfo_(to);
  res.moved = true;
  res.ok = true;
  return res;
}
