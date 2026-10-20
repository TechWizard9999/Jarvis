#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';
import { doctor } from './doctor.ts';
const config = loadConfig();
const [command = 'help', ...argv] = process.argv.slice(2);
function option(name: string) { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; }
async function acceptance() { const file = option('--acceptance'); return file ? JSON.parse(await fs.readFile(file, 'utf8')) : undefined; }
async function api(endpoint: string, method = 'GET', body?: unknown) {
  const token = (await fs.readFile(path.join(config.stateDir, 'ui-token'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${config.port}${endpoint}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text()); return response;
}
// Streams a run's events until its outcome; reconnects after a dropped stream (from the last seen event) and stops once
// the run is complete, including runs a controller restart marked interrupted.
async function follow(id: string) {
  let after = 0;
  for (;;) {
    try {
      const response = await api(`/api/runs/${id}/events?after=${after}`); if (!response.body) throw new Error('No event stream'); const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of response.body) { buffer += decoder.decode(chunk, { stream: true }); let split: number; while ((split = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, split); buffer = buffer.slice(split + 2); const data = block.split('\n').find(l => l.startsWith('data: ')); if (data) { const e = JSON.parse(data.slice(6)); after = Math.max(after, e.seq); console.log(`[${e.time}] ${e.stage} ${e.source}: ${e.message}`); if (e.kind === 'outcome') return; } } }
    } catch {}
    const run = await api(`/api/runs/${id}`).then(r => r.json()).catch(() => null) as any;
    if (run?.stage === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
try {
  if (command === 'serve') {
    const app = await createServer(config); await new Promise<void>(resolve => app.server.listen(config.port, config.bind, resolve));
    console.log(`RTK Bugfix Agent: http://localhost:${config.port}/?token=${app.uiToken}`);
    const stop = async () => { for (const id of app.pipeline.contexts.keys()) await app.pipeline.cancel(id).catch(() => {}); app.server.close(() => process.exit(0)); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } else if (command === 'doctor') {
    const checks = await doctor(config); for (const c of checks) console.log(`${c.ok ? 'PASS' : c.required ? 'FAIL' : 'NOTE'} ${c.name}: ${c.detail}`); if (checks.some(c => c.required && !c.ok)) process.exitCode = 1;
  } else if (command === 'run') {
    const response = await api('/api/runs', 'POST', { repo: option('--repo'), issue: option('--issue'), base: option('--base'), mode: option('--mode') || 'live', retrieval: option('--retrieval') || 'graph', publish: argv.includes('--publish') && !argv.includes('--no-publish'), acceptance: await acceptance(), allowCompeting: argv.includes('--allow-competing') }); console.log(JSON.stringify(await response.json(), null, 2));
  } else if (command === 'fix') {
    // One-step flow: issue URL -> live run on the profile's default clone -> streamed progress -> outcome, report and draft PR link.
    const issue = argv.find(a => !a.startsWith('--') && a !== option('--repo') && a !== option('--acceptance')); if (!issue) throw new Error('Usage: fix ISSUE_URL [--repo PATH] [--acceptance JSON_FILE] [--no-publish]');
    const repo = option('--repo') || path.join(config.repoRoot, config.profile.upstream.split('/')[1]);
    const started = await (await api('/api/runs', 'POST', { repo, issue, mode: 'live', retrieval: 'graph', publish: !argv.includes('--no-publish'), acceptance: await acceptance(), allowCompeting: argv.includes('--allow-competing') })).json(); const id = started.id || started.run?.id;
    console.log(`Run ${id} started for ${issue}`); await follow(id);
    const run = ((await (await api('/api/runs')).json()) as any[]).find(r => r.id === id) || {};
    console.log(`\nOutcome: ${run.outcome}\nRoot-cause report: ${path.join(config.stateDir, 'runs', id, 'report.md')}`);
    if (run.publication?.url) console.log(`Draft PR: ${run.publication.url}`); else if (run.publication?.error) console.log(`Publication error: ${run.publication.error}`);
    // Success means the requested result exists: a draft PR when publishing, otherwise a verified patch.
    if (argv.includes('--no-publish') ? !['verified_patch', 'verified_unpublished', 'draft_created'].includes(run.outcome) : !run.publication?.url) process.exitCode = 1;
  } else if (command === 'demo') console.log(JSON.stringify(await (await api('/api/demo', 'POST')).json(), null, 2));
  else if (command === 'list') console.log(JSON.stringify(await (await api('/api/runs')).json(), null, 2));
  else if (command === 'cancel' || command === 'publish') console.log(JSON.stringify(await (await api(`/api/runs/${argv[0]}/${command}`, 'POST')).json(), null, 2));
  else if (command === 'inspect-pr') console.log(JSON.stringify(await (await api(`/api/runs/${argv[0]}/publication`)).json(), null, 2));
  else if (command === 'note') { if (!argv[0] || !option('--kind') || !option('--message')) throw new Error('Usage: note ID --kind guidance|manual_fix|harness_fix|review --message TEXT'); console.log(JSON.stringify(await (await api(`/api/runs/${argv[0]}/interventions`,'POST',{kind:option('--kind'),message:option('--message')})).json(),null,2)); }
  else if (command === 'tail') await follow(argv[0]);
  else console.log('Commands: serve, doctor, fix ISSUE_URL [--no-publish], run --repo PATH --issue URL [--publish] [--mode evaluation --base SHA --no-publish], list, tail ID, cancel ID, publish ID, inspect-pr ID, note ID --kind KIND --message TEXT, demo. Use ./bugfix for Docker setup/build/up/clone commands.');
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
