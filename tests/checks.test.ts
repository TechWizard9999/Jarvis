import test from 'node:test';
import assert from 'node:assert/strict';
import { fastChecks, focusedCheck } from '../src/checks.ts';
test('top-level test modules are accepted while exact tests require their qualified name', () => {
  assert.ok(focusedCheck('test-module', 'tests').includes('tests::'));
  assert.throws(() => focusedCheck('test-focused', 'tests'), /qualified/);
  const checks = fastChecks('tests::regression');
  assert.equal(checks.at(-1)?.[0], 'test-module');
  assert.ok(checks.every(([, args]) => args[1] === 'fmt' || args.includes('--locked') && args.includes('--offline')));
});
