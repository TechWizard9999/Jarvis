import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './store.ts';
import { writeReport } from './report.ts';
import { defaultProfile } from './profile.ts';
import type { RepositoryProfile } from './profile.ts';
export async function demo(store: Store, profile: RepositoryProfile = defaultProfile) {
  const run = await store.create({ repo: `/demo/${profile.id}`, issue: `https://github.com/${profile.upstream}/issues/1`, mode: 'demo', retrieval: 'graph', publish: false });
  run.profile = structuredClone(profile);
  void (async () => {
    for (const [stage, text] of [
      ['preflight', 'SIMULATED: inspecting a sample local clone'], ['environment', 'SIMULATED: dependency cache ready'],
      ['discovery', 'SIMULATED: Graphify locates a filter and its callers'], ['reproduction', 'SIMULATED: error-preservation assertion fails'],
      ['patching', 'SIMULATED: candidate preserves the error line'], ['verification', 'SIMULATED: demonstrating independent check results'],
    ] as const) {
      await store.stage(run, stage, text); await store.event(run, 'demo', 'output', text + '\n'); await delay(350);
    }
    run.stage = 'complete'; run.outcome = 'demo_complete'; run.error = 'This was a UI demonstration only. No model, repository, Docker verification, or GitHub publication was used.';
    await store.save(run); await writeReport(store, run); await store.event(run, 'demo', 'outcome', 'Demo complete — not a verified repair');
  })().catch(async e => { run.outcome = 'interrupted'; run.error = String(e); await store.save(run); });
  return run;
}
