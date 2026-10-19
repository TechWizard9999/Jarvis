import test from 'node:test';
import assert from 'node:assert/strict';
import { exec } from '../src/process.ts';
test('command deadlines terminate a running child and preserve timeout status', async () => {
  const result = await exec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 80 });
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0); assert.ok(result.durationMs < 4000);
});
