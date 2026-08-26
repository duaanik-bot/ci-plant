// Post-deploy smoke check for the live plant ERP. Exits non-zero when the
// deployment is not actually serving, so it can gate `npm run deploy:prod`.
//
//   npm run verify:prod
//   npm run verify:prod -- --url https://ci-plant-xyz.vercel.app
//
// The check that matters most here is the one that reads oddly: a hashed asset
// that does NOT exist must answer 404. On 2026-08-26 it answered 200 with
// index.html, because the SPA catch-all matched `/assets/…` like any other
// path. A browser will not accept HTML as a stylesheet, so a tablet whose page
// predated the deploy rendered Live Floor — real figures, 56 in the queues — in
// raw browser-default HTML and said nothing about why. Nothing in the request
// log looked wrong: every response was a 200.
const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const BASE = (urlArg >= 0 ? args[urlArg + 1] : 'https://motionci.in').replace(/\/+$/, '');
// A production alias needs a moment after a deploy; tests of this script itself
// do not, hence the override.
const DEADLINE_MS = Number(process.env.VERIFY_PROD_DEADLINE_MS ?? 120_000);
const GAP_MS = 6_000;

const bust = () => `cb=${process.pid}-${checks}-${Date.now()}`;
let checks = 0;

async function get(path, { method = 'GET' } = {}) {
  checks++;
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}${bust()}`, {
    method,
    redirect: 'follow',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
}

// Each check returns null when it passes, or a sentence saying what is wrong.
async function runAll() {
  const failures = [];
  const fail = m => failures.push(m);

  const index = await get('/');
  if (index.status !== 200) fail(`the app shell answered ${index.status}, not 200`);
  if (!/text\/html/.test(index.type)) fail(`the app shell is ${index.type}, not HTML`);

  // The recovery guard is what lets a tablet mid-shift heal itself across the
  // NEXT deploy. A build that drops it fails quietly a release later, which is
  // the worst time to find out.
  if (!index.body.includes('ci:stale-build-reload')) {
    fail('the stale-build recovery guard is missing from the served index.html');
  }

  // Everything this document asks for must actually be there.
  const refs = [...index.body.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
  if (!refs.length) fail('the app shell references no /assets/ files at all — did the build emit?');
  for (const ref of refs) {
    const a = await get(ref);
    const want = ref.endsWith('.css') ? /text\/css/ : /javascript/;
    if (a.status !== 200) fail(`${ref} answered ${a.status}`);
    else if (!want.test(a.type)) fail(`${ref} is being served as ${a.type}`);
  }

  // THE regression check. A hash that was never built must 404 — never a
  // document, and never with a text/html content type.
  for (const gone of ['/assets/index-NOSUCHBUILD.css', '/assets/Planning-NOSUCHBUILD.js']) {
    const g = await get(gone);
    if (g.status !== 404) {
      fail(`${gone} answered ${g.status} (${g.type}) instead of 404 — the SPA catch-all is `
        + 'swallowing missing build output again, and a tablet that predates this deploy '
        + 'will render the app with no stylesheet at all');
    }
    if (/text\/html/.test(g.type)) fail(`${gone} came back as HTML, which a browser refuses in silence`);
  }

  // A deep link still has to reach the app shell.
  const route = await get('/floor/printing');
  if (route.status !== 200 || !/text\/html/.test(route.type)) {
    fail(`a client route answered ${route.status} ${route.type}; deep links are broken`);
  }

  const health = await get('/api/health');
  if (health.status !== 200) fail(`/api/health answered ${health.status}`);
  else {
    try {
      if (JSON.parse(health.body).ok !== true) fail(`/api/health said ${health.body.slice(0, 120)}`);
    } catch { fail(`/api/health returned non-JSON: ${health.body.slice(0, 120)}`); }
  }

  return failures;
}

// A production alias takes a moment to point at a new deployment, so a first
// failure is not yet news. A persistent one is.
const started = Date.now();
let failures = await runAll();
while (failures.length && Date.now() - started < DEADLINE_MS) {
  process.stdout.write(`  …not ready yet (${failures.length} failing), retrying\n`);
  await new Promise(r => setTimeout(r, GAP_MS));
  failures = await runAll();
}

if (failures.length) {
  console.error(`\n✗ ${BASE} is not serving correctly:\n`);
  for (const f of failures) console.error(`   • ${f}`);
  console.error(`\n  ${checks} requests over ${Math.round((Date.now() - started) / 1000)}s.`);
  process.exit(1);
}

console.log(`✓ ${BASE} verified — shell, assets, stale-asset 404, deep link, API health `
  + `(${checks} requests, ${Math.round((Date.now() - started) / 1000)}s)`);
