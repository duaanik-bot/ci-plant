// The post-deploy check has to survive the deploy it is checking.
//
// `verify-prod.mjs` is built around retrying: a production alias takes a moment
// to point at a new deployment, so a first failure is not yet news. But every
// fetch sat outside any catch, so a connection that TIMED OUT — precisely what
// happens while the alias is moving — threw straight out of runAll() and killed
// the process before the retry loop could do its job.
//
// Seen for real on 2026-08-26: a deployment that was serving perfectly reported
//   TypeError: fetch failed ... UND_ERR_CONNECT_TIMEOUT
// as a raw Node stack trace. On the `smoke` job that is a red build on a good
// deploy, and nothing in the output tells you which of the two you are looking
// at. An unreachable host must read as "could not reach it, retrying", the same
// as any other failure, and must never surface as a stack trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/verify-prod.mjs', import.meta.url));

// A port nothing is listening on — opened, its number taken, then closed, so it
// is genuinely free rather than merely assumed to be.
function deadPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
}

test('an unreachable host is reported, not thrown', async () => {
  const port = await deadPort();
  const { code, out } = await run(['--url', `http://127.0.0.1:${port}`], { VERIFY_PROD_DEADLINE_MS: '1500' });

  assert.equal(code, 1, 'a site that cannot be reached is a failed check');
  assert.doesNotMatch(out, /at ModuleJob\.run|at async|UND_ERR|TypeError: fetch failed/,
    'a raw Node stack trace means the fetch escaped the retry loop and killed the '
    + 'process — the whole point of this script is that it retries while an alias moves');
  assert.match(out, /is not serving correctly|could not reach/i,
    'it has to say what is wrong in the script\'s own words');
});
