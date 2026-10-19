/** Inspect the actual configured clone without calling a model or publishing anything. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { Repository } from '../src/git.ts';
import { Docker } from '../src/docker.ts';
import { Store, atomicJson } from '../src/store.ts';
import { checked } from '../src/process.ts';

const project = process.cwd(), config = loadConfig({ ...process.env, BUGFIX_STATE_DIR: path.join(project, 'state/readiness', randomBytes(5).toString('hex')) });
const repoIndex = process.argv.indexOf('--repo'), repo = repoIndex < 0 ? path.join(config.repoRoot, config.profile.upstream.split('/')[1]) : process.argv[repoIndex + 1];
const store = new Store(config.stateDir), docker = new Docker(config, store), repository = new Repository(config);
const run = await store.create({ repo, issue: `https://github.com/${config.profile.upstream}/issues/1`, mode: 'evaluation', publish: false });
run.profile = structuredClone(config.profile); run.issue = { number: 1, url: run.input.issue, title: 'Environment readiness only (no issue fetched)', body: '' };
const base = path.join(store.dir(run.id), 'base');
const results: Record<string, unknown> = { testedAt: new Date().toISOString(), repository: config.profile.upstream, modelContacted: false, publicationAttempted: false, evidence: store.dir(run.id) };
let stage = 'snapshot';
store.on(run.id, e => { if (e.source === 'docker' && e.kind === 'output') process.stdout.write(e.message); });
try {
  await repository.preflight(run, base); results.base = run.baseSha;
  stage = 'graph';
  const worker = await docker.startWorker(run, base, config.workerImage, true, 'graph-readiness');
  const graph = await docker.inContainer(run, worker, ['graphify', 'extract', '/workspace', '--code-only', '--no-cluster', '--max-workers', '1', '--out', '/build/graphify-out']);
  results.graphExtraction = { exitCode: graph.code, durationMs: graph.durationMs };
  checked(graph, 'Graphify extraction');
  const probes = process.argv.filter(a => a.startsWith('--symbol=')).map(a => a.slice('--symbol='.length));
  const symbols = probes.length ? probes : config.profile.id === 'rtk' ? ['filter_status_with_args', 'src_lib_commands', 'NoFilter'] : [];
  const explanations = [];
  for (const symbol of symbols) {
    const result = await docker.inContainer(run, worker, ['graphify', 'explain', symbol, '--graph', '/build/graphify-out/graph.json']);
    explanations.push({ symbol, exitCode: result.code, output: result.stdout + result.stderr });
  }
  results.graphProbes = explanations;
  await docker.remove(worker);
  if (process.argv.includes('--baseline')) {
    stage = 'baseline';
    const abort = new AbortController();
    await docker.prepare(run, base, abort.signal); results.baseline = { outcome: 'passed', imageId: run.imageId, checks: config.profile.checks };
  } else results.baseline = { outcome: 'not_requested' };
  results.outcome = 'passed';
} catch (error) { results.outcome = 'blocked'; results.blockedStage = stage; if (stage === 'baseline') results.baseline = { outcome: 'blocked' }; results.error = String(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally {
  await docker.cleanup(run); await store.save(run);
  await atomicJson(path.join(project, process.argv.includes('--baseline') ? 'state/readiness-results.json' : 'state/graph-results.json'), results);
  console.log(JSON.stringify(results, null, 2));
}
