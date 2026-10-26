import test from 'node:test';
import assert from 'node:assert/strict';
import type { AcceptanceRequirement, Issue } from '../src/types.ts';

const issue: Issue = { number: 1, url: 'https://github.com/rtk-ai/rtk/issues/1', title: 'Title text is not body evidence.', body: '## Report\nThe **error line** must be preserved.\nNormal output must still be preserved.\nDo not change exit status.' };
const plan = (): AcceptanceRequirement[] => [
  { id: 'reported-error', baseline: 'fail', required: true, target: { kind: 'unit' }, expectedBehavior: 'Preserve the reported error line.', citation: 'The **error line** must be preserved.' },
  { id: 'ordinary-control', baseline: 'pass', expectedBehavior: 'Preserve ordinary normal output.', citation: 'Normal output must still be preserved.' },
];
async function validate(input: unknown) {
  const modulePath = '../src/planning.ts';
  const api = await import(modulePath).catch(() => null);
  assert.ok(api, 'Acceptance plan validation is required before freezing a model plan');
  return api.validateAcceptancePlan(input, issue) as { errors: { path: string; message: string }[]; requirements?: AcceptanceRequirement[] };
}

test('a valid plan is cloned without rewriting its citations, behavior or optional defaults', async () => {
  const submitted = plan(), original = structuredClone(submitted);
  const result = await validate(submitted);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.requirements, original);
  assert.notEqual(result.requirements, submitted);
  assert.notEqual(result.requirements![0].target, submitted[0].target);
  result.requirements![0].citation = 'changed after validation';
  assert.deepEqual(submitted, original);
  assert.equal(Object.hasOwn(result.requirements![1], 'required'), false);
  assert.equal(Object.hasOwn(result.requirements![1], 'target'), false);
});

test('an inaccurate issue quotation is rejected with its precise field while other rows are checked', async () => {
  const submitted = plan();
  submitted[0].citation = 'The error line should be preserved.';
  submitted[1].citation = 'Ordinary output must be preserved.';
  const original = structuredClone(submitted), result = await validate(submitted);
  assert.equal(result.requirements, undefined);
  assert.deepEqual(result.errors.map(error => error.path), ['requirements[0].citation', 'requirements[1].citation']);
  assert.ok(result.errors.every(error => /exact|verbatim|contiguous/i.test(error.message)));
  assert.deepEqual(submitted, original);
});

test('title citations require an explicit source and retain exact quotation checks', async () => {
  const submitted: any[] = plan(); submitted[0].citation = issue.title;
  assert.ok((await validate(submitted)).errors.some(error => error.path === 'requirements[0].citation'));
  submitted[0].citationSource = 'title';
  assert.deepEqual((await validate(submitted)).errors, []);
  submitted[0].citation = 'Title text should count as evidence.';
  assert.ok((await validate(submitted)).errors.some(error => error.path === 'requirements[0].citation'));
  submitted[0].citationSource = 'repository';
  assert.ok((await validate(submitted)).errors.some(error => error.path === 'requirements[0].citationSource'));
});

test('citation compatibility permits only existing Markdown and whitespace normalization', async () => {
  const submitted = plan();
  submitted[0].citation = 'The error\n  line must be preserved.';
  assert.deepEqual((await validate(submitted)).errors, []);
  for (const citation of ['Title text is not body evidence.', 'The error line must be preserved!', 'The error line must be preserved. Normal output', 'The error line ... preserved.', 'error']) {
    const candidate = plan(); candidate[0].citation = citation;
    const result = await validate(candidate);
    // The contiguous cross-line excerpt is valid after the established normalization.
    if (citation === 'The error line must be preserved. Normal output') assert.deepEqual(result.errors, []);
    else assert.ok(result.errors.some(error => error.path === 'requirements[0].citation'), citation);
  }
});

test('all invalid row fields are reported before any plan can be frozen', async () => {
  const submitted = [null, { id: 'bad id', baseline: 'wrong', required: 'true', expectedBehavior: 'short', citation: 42, target: { kind: 'integration', name: '../cli' } }, { ...plan()[0], target: { kind: 'shell' } }];
  const result = await validate(submitted), paths = result.errors.map(error => error.path);
  for (const field of ['requirements[0]', 'requirements[1].id', 'requirements[1].baseline', 'requirements[1].required', 'requirements[1].expectedBehavior', 'requirements[1].citation', 'requirements[1].target.name', 'requirements[2].target.kind']) assert.ok(paths.includes(field), field);
  assert.equal(result.requirements, undefined);
});

test('invalid container, row count, duplicate IDs and non-required bug/control cannot pass', async () => {
  for (const input of [undefined, null, {}, { requirements: plan() }, [], plan().slice(0, 1), Array.from({ length: 13 }, (_, index) => ({ ...plan()[index % 2], id: `row-${index}` }))]) {
    const result = await validate(input);
    assert.ok(result.errors.some(error => error.path === 'requirements'));
    assert.equal(result.requirements, undefined);
  }
  const duplicate = plan(); duplicate[1].id = duplicate[0].id;
  assert.ok((await validate(duplicate)).errors.some(error => error.path === 'requirements[1].id'));
  for (const index of [0, 1]) {
    const optionalOnly = plan(); optionalOnly[index].required = false;
    assert.ok((await validate(optionalOnly)).errors.some(error => error.path === 'requirements'));
  }
});

test('integration targets use canonical Cargo stems and cannot hide malformed optional fields', async () => {
  const valid = plan(); valid[0].target = { kind: 'integration', name: '_cli-behavior_2' };
  assert.deepEqual((await validate(valid)).errors, []);
  for (const target of [null, [], 'unit', {}, { kind: 'integration' }, { kind: 'integration', name: '-flag' }, { kind: 'integration', name: 'cli.rs' }, { kind: 'integration', name: 'cli/path' }, { kind: 'integration', name: 1 }]) {
    const malformed: any[] = plan(); malformed[0].target = target;
    assert.ok((await validate(malformed)).errors.some(error => error.path.startsWith('requirements[0].target')), JSON.stringify(target));
  }
  const malformed: any[] = plan(); malformed[0].required = null;
  assert.ok((await validate(malformed)).errors.some(error => error.path === 'requirements[0].required'));
});
