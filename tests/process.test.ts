import test from 'node:test';
import assert from 'node:assert/strict';
import { exec } from '../src/process.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('command deadlines terminate a running child and preserve timeout status', async () => {
  const result = await exec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 80 });
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0); assert.ok(result.durationMs < 4000);
});
test('already cancelled commands never spawn or create side effects', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abort-command-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'spawned'); const abort = new AbortController(); abort.abort(new Error('cancelled before spawn'));
  await assert.rejects(exec(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "spawned")', marker], { signal: abort.signal }), /cancelled before spawn/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
test('cancelling a live command rejects with the cancellation reason', async () => {
  const abort = new AbortController(); const command = exec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { signal: abort.signal });
  setTimeout(() => abort.abort(new Error('cancel during execution')), 50);
  await assert.rejects(command, /cancel during execution/);
});
