import { providerBody, providerRetrySeconds, rejectsReasoningBudget, type ModelTurnPurpose } from './provider.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pipeline } from './pipeline.ts';
import { Store } from './store.ts';
import { demo } from './demo.ts';
import { doctor } from './doctor.ts';
import { filterProviderTools } from './agent.ts';
import { safeRelative, sourcePath } from './files.ts';
import type { Config, RunEvent, Manifest } from './types.ts';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function providerSettings(body: Record<string, any>): Record<string, unknown> {
  const settings = Object.fromEntries(['model','max_tokens','temperature','top_p','top_k','min_p','seed','presence_penalty','frequency_penalty','reasoning_effort','reasoning_budget'].filter(key => ['string','number','boolean'].includes(typeof body[key])).map(key => [key,body[key]]));
  for (const [key, fields] of [['thinking',['type','budget_tokens']],['reasoning',['effort','max_tokens','summary']],['chat_template_kwargs',['enable_thinking','medium_effort']]] as const) {
    const source = body[key];
    if (source && typeof source === 'object') settings[key] = Object.fromEntries(fields.filter(field => ['string','number','boolean'].includes(typeof source[field])).map(field => [field,source[field]]));
  }
  return settings;
}
async function jsonBody(req: http.IncomingMessage, max = 4_000_000): Promise<any> {
  let size = 0; const parts: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error(`Request body is too large (limit ${max} bytes)`); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
export async function createServer(config: Config, options: { recover?: boolean; providerRequest?: typeof fetch } = {}) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 }); await fs.mkdir(config.repoRoot, { recursive: true });
  const tokenFile = path.join(config.stateDir, 'ui-token');
  const uiToken = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim() || randomBytes(32).toString('hex');
  await fs.writeFile(tokenFile, uiToken, { mode: 0o600 });
  const store = new Store(config.stateDir); const pipeline = new Pipeline(config, store);
  // An observed capability is scoped to this controller lifetime and exact configured endpoint/model.
  const unsupportedBudgets = new Map<string, { observedAt: string }>();
  if (options.recover !== false) await pipeline.recover();
  const json = (res: http.ServerResponse, data: unknown, code = 200) => { if(res.destroyed || res.writableEnded)return;res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // Internal model/tool traffic is authenticated independently and never trusts a browser cookie.
      const internal = /^\/internal\/([a-z0-9-]+)\/tools\/([a-z_]+)$/.exec(url.pathname);
      if (internal) {
        const context = pipeline.contexts.get(internal[1]);
        if (!context || !equal(req.headers.authorization || '', `Bearer ${context.agent.toolToken}`)) return json(res, { error: 'Unauthorized tool bridge' }, 401);
        if (req.method !== 'POST') return json(res, { error: 'POST required' }, 405);
        return json(res, await pipeline.tool(internal[1], internal[2], await jsonBody(req)));
      }
      const provider = /^\/provider\/([a-z0-9-]+)\/v1\/(chat\/completions|models)$/.exec(url.pathname);
      if (provider) {
        const context = pipeline.contexts.get(provider[1]);
        if (!context || !equal(req.headers.authorization || '', `Bearer ${context.agent.providerToken}`)) return json(res, { error: 'Unauthorized model gateway' }, 401);
        pipeline.ensureActive(context);
        if (provider[2] === 'models' && req.method === 'GET') return json(res, { object: 'list', data: [{ id: config.model.split('/').slice(1).join('/'), object: 'model' }] });
        if (req.method !== 'POST' || context.phase === 'locked') return json(res, { error: 'Model requests are unavailable in this stage' }, 409);
        // JSON escaping and tool schemas add bytes beyond tokenized input. Keep capacity finite and context-aware.
        const bodyLimit = Math.max(4_000_000, config.modelContext * 32 + 1_000_000);
        const input = await jsonBody(req, bodyLimit); const filtered = filterProviderTools(context.run, input);
        const expectedModel = config.model.slice(config.model.indexOf('/') + 1);
        if (input.model !== expectedModel) return json(res, { error: 'Model ID does not match the recorded configuration' }, 400);
        const key = (await fs.readFile(config.nvidiaSecret, 'utf8')).trim();
        if (!key || /\s/.test(key)) throw new Error('NVIDIA secret file is empty or invalid');
        // Per-request output is capped at the model's configured limit; total usage is only reported, never capped.
        const turnPurpose = context.agent.turnPurpose || context.phase;
        const turnPurposeSource = context.agent.turnPurpose ? 'active_turn' : 'stage_fallback';
        const body = providerBody(filtered.body,config,turnPurpose as ModelTurnPurpose);
        const target = new URL(config.providerBaseUrl.endsWith('/') ? config.providerBaseUrl : config.providerBaseUrl + '/');
        if (target.protocol !== 'https:' || target.username || target.password) throw new Error('The NVIDIA endpoint must be a credential-free HTTPS URL');
        const requestedSettings = providerSettings(body);
        const capabilityKey = JSON.stringify([target.href, body.model]);
        const cachedBudget = typeof body.reasoning_budget === 'number' ? unsupportedBudgets.get(capabilityKey) : undefined;
        if (cachedBudget) delete body.reasoning_budget;
        const settings = providerSettings(body);
        const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        // The active controller turn does not identify OpenCode's internal requests (for example compaction).
        const contextLimits = { context: config.modelContext, input: config.modelInput, compactionReserved: config.compactionReserved };
        const record: NonNullable<Manifest['modelRequests']>[number] & {settings: Record<string, unknown>; settingsSha256: string; promptSha256: string} = {id:randomBytes(12).toString('hex'),startedAt:new Date().toISOString(),attempts:0,model:input.model,turnPurpose,turnPurposeSource,internalPurpose:'unknown',contextLimits,usage:'unknown',status:'pending',settings,settingsSha256:hash(settings),requestedSettings,requestedSettingsSha256:hash(requestedSettings),answerReserve:cachedBudget?'unavailable':typeof body.reasoning_budget==='number' && body.reasoning_budget>0?'requested':'not_requested',promptSha256:hash(input.messages || [])};
        if (cachedBudget) record.parameterOmissions = [{ parameter:'reasoning_budget',reason:'nvidia_v2_model_runner_unsupported',source:'cached_provider_rejection',observedAt:cachedBudget.observedAt }];
        (context.run.modelRequests ||= []).push(record); await store.save(context.run);
        await store.event(context.run, 'gateway', 'model_request', 'Approved outbound model tool list', {requestId:record.id,tools:filtered.names,removedTools:filtered.removed,model:input.model,turnPurpose,turnPurposeSource,internalPurpose:record.internalPurpose,contextLimits,settings,settingsSha256:record.settingsSha256,requestedSettings,requestedSettingsSha256:record.requestedSettingsSha256,parameterOmissions:record.parameterOmissions,answerReserve:record.answerReserve,promptSha256:record.promptSha256});
        // One request lives until the run is cancelled or the agent disconnects (OpenCode then sends a new request).
        let completed = false, interrupted = false;
        const readUsage = (data: any) => {
          const finish = Array.isArray(data?.choices) ? data.choices.find((choice: any) => typeof choice?.finish_reason === 'string')?.finish_reason : undefined;
          if (finish !== undefined) record.finishReason = finish;
          const usage=data?.usage;if(!usage || typeof usage!=='object')return;
          const count=(...keys: string[])=>{for(const key of keys){const value=usage[key];if(typeof value==='number' && Number.isFinite(value) && value>=0)return value;}return undefined;};
          const input=count('prompt_tokens','input_tokens'),output=count('completion_tokens','output_tokens'),total=count('total_tokens');
          if(input!==undefined)record.inputTokens=Math.max(record.inputTokens ?? 0,input);if(output!==undefined)record.outputTokens=Math.max(record.outputTokens ?? 0,output);
          const observed=total ?? (input!==undefined && output!==undefined?input+output:undefined);if(observed!==undefined)record.totalTokens=Math.max(record.totalTokens ?? 0,observed);
          if(input!==undefined || output!==undefined || observed!==undefined)record.usage='partial';
          const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
          if (typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0) record.reasoningTokens = Math.max(record.reasoningTokens ?? 0, reasoning);
        };
        const request = new AbortController(); const stopRequest = () => request.abort(context.abort.signal.reason);
        context.abort.signal.addEventListener('abort', stopRequest, { once: true });if(context.abort.signal.aborted || res.destroyed)stopRequest();
        res.on('close', () => { if (!res.writableEnded) request.abort(new Error('Agent disconnected from the model gateway')); });
        try {
          // Wait out rate limits (every 429) and transient provider/network failures (5xx or connection errors, 5 times) here
          // rather than hand them to OpenCode, whose own retries give up.
          let upstream: Response | undefined, failures = 0, capabilityRetried = false;
          for (let attempt = 0; ; attempt++) {
            let problem = ''; upstream = undefined;
            try {
              request.signal.throwIfAborted();record.attempts++;
              upstream = await (options.providerRequest || fetch)(target.href.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal });
              record.httpStatus=upstream.status;
              if (!capabilityRetried && await rejectsReasoningBudget(upstream, body)) {
                capabilityRetried = true;
                const observedAt = new Date().toISOString(); unsupportedBudgets.set(capabilityKey, { observedAt });
                delete body.reasoning_budget;
                record.parameterOmissions = [{ parameter:'reasoning_budget',reason:'nvidia_v2_model_runner_unsupported',source:'provider_rejection',observedAt }];
                record.answerReserve = 'unavailable'; record.settings = providerSettings(body); record.settingsSha256 = hash(record.settings);
                await store.save(context.run);
                await store.event(context.run, 'gateway', 'provider_capability_fallback', 'NVIDIA V2 runner rejected reasoning_budget; retrying once without it. Final-answer/tool-call reserve is unavailable.', {requestId:record.id,parameterOmissions:record.parameterOmissions,requestedSettings,requestedSettingsSha256:record.requestedSettingsSha256,settings:record.settings,settingsSha256:record.settingsSha256,answerReserve:record.answerReserve});
                await upstream.body?.cancel().catch(() => {});
                continue;
              }
              if ([401, 403, 404].includes(upstream.status)) context.providerRejected = `HTTP ${upstream.status}`; // bad key or unknown model
              if (upstream.status === 429) problem = 'HTTP 429';
              else if (upstream.status >= 500 && ++failures <= 5) problem = `HTTP ${upstream.status}`;
              else break;
              await upstream.body?.cancel().catch(() => {});
            } catch (error) {
              if (request.signal.aborted || ++failures > 5) return res.headersSent ? res.destroy() : json(res, { error: `Model provider unreachable: ${String(error)}` }, 502);
              problem = String(error);
            }
            const seconds = providerRetrySeconds(upstream?.headers,attempt);
            await store.event(context.run, 'gateway', problem === 'HTTP 429' ? 'rate_limited' : 'provider_retry', `Model ${problem}; retrying in ${seconds}s`);
            await sleep(seconds * 1000, undefined, { signal: request.signal });
          }
          if(res.destroyed || res.writableEnded || request.signal.aborted)return;
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
          if (!upstream.body) {completed=true;return res.end();}
          let buffer = ''; const decoder = new TextDecoder();
          try {
            for await (const chunk of upstream.body) {
              if(res.destroyed || res.writableEnded || request.signal.aborted)throw new Error('Model response disconnected');
              res.write(chunk); buffer += decoder.decode(chunk, { stream: true });
              let index: number;
              while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).replace(/^data:\s*/, '').trim(); buffer = buffer.slice(index + 1);
                try {readUsage(JSON.parse(line));}catch {}
              }
              if (buffer.length > 1_000_000) buffer = buffer.slice(-100000);
            }
          } catch (error) {
            // A broken stream must reach OpenCode as a transport error, not as a silently truncated (retry-less) answer.
            interrupted=true;
            await store.event(context.run, 'gateway', 'model_error', `Model stream interrupted: ${String(error)}`); return res.destroy();
          }
          try {readUsage(JSON.parse(buffer));}catch {}
          completed=true;return res.end();
        } finally {
          context.abort.signal.removeEventListener('abort', stopRequest);
          record.finishedAt=new Date().toISOString();record.latencyMs=Math.max(0,Date.parse(record.finishedAt)-Date.parse(record.startedAt));
          record.status=completed?(record.httpStatus && record.httpStatus>=400?'failed':'completed'):interrupted || request.signal.aborted?'interrupted':'failed';
          if(completed && record.totalTokens!==undefined)record.usage='complete';
          context.run.tokens+=record.totalTokens ?? 0;
          await store.save(context.run);
          await store.event(context.run,'gateway',record.status==='completed'?'model_finished':'model_error',`Model ${record.httpStatus?`HTTP ${record.httpStatus}`:record.status}; reported tokens ${record.totalTokens ?? 'unknown'} (${record.usage})`,{requestId:record.id,...record});
        }
      }
      const browserOrigin = req.headers.origin;
      if (browserOrigin && new URL(browserOrigin).host !== req.headers.host) return json(res, { error: 'Cross-origin requests are not permitted' }, 403);
      const cookie = /(?:^|;\s*)bugfix_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1] || '';
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      const supplied = url.searchParams.get('token') || '';
      const authorized = equal(cookie, uiToken) || equal(bearer, uiToken) || equal(supplied, uiToken);
      if (!authorized) {
        if (url.pathname === '/') { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>RTK Bugfix Agent</title><p>Open the dashboard URL printed by <code>./bugfix up</code> to authenticate.</p>'); }
        return json(res, { error: 'Use the authenticated local dashboard URL or CLI' }, 401);
      }
      if (supplied) {
        res.writeHead(303, { location: '/', 'set-cookie': `bugfix_session=${uiToken}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' }); return res.end();
      }
      if (url.pathname === '/api/status' && req.method === 'GET') return json(res, { model: config.model, repoRoot: config.repoRoot, profile: config.profile, configuredFork: config.fork, active: [...pipeline.contexts.keys()], version: '0.1.0' });
      if (url.pathname === '/api/doctor' && req.method === 'GET') return json(res, await doctor(config));
      if (url.pathname === '/api/runs' && req.method === 'GET') return json(res, await store.list());
      if (url.pathname === '/api/runs' && req.method === 'POST') return json(res, await pipeline.start(await jsonBody(req)), 202);
      if (url.pathname === '/api/demo' && req.method === 'POST') return json(res, await demo(store, config.profile), 202);
      const route = /^\/api\/runs\/([a-z0-9-]+)(?:\/(events|history|cancel|publish|publication|interventions|artifact|diff))?$/.exec(url.pathname);
      if (route) {
        const [, id, action] = route; const run = await store.get(id);if(res.destroyed || res.writableEnded)return;
        if (!action && req.method === 'GET') return json(res, run);
        if (action === 'interventions' && req.method === 'POST') { const note=await jsonBody(req,20000); return json(res,await pipeline.recordIntervention(id,note.kind,note.message)); }
        if (action === 'cancel' && req.method === 'POST') { await pipeline.cancel(id); return json(res, { cancelling: true }); }
        if (action === 'publication' && req.method === 'GET') return json(res, await pipeline.refreshPublication(id));
        if (action === 'publish' && req.method === 'POST') return json(res, await pipeline.retryPublication(id));
        if (action === 'diff' && req.method === 'GET') { const diff = await fs.readFile(path.join(store.dir(id), 'candidate.patch'), 'utf8').catch(async () => run.worktree ? (await pipeline.repository.git(run.worktree, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv'])).stdout : ''); return json(res, { diff }); }
        if (action === 'history' && req.method === 'GET') {
          const number = (key: string) => { const value = url.searchParams.get(key); if (value === null) return undefined; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${key} cursor`); return parsed; };
          return json(res, await store.eventPage(id, {before:number('before'),after:number('after'),limit:number('limit'),search:url.searchParams.get('search') || undefined,stage:url.searchParams.get('stage') || undefined,source:url.searchParams.get('source') || undefined,errors:url.searchParams.get('errors') === 'true'}));
        }
        if (action === 'artifact' && req.method === 'GET') {
          const relative = safeRelative(url.searchParams.get('path') || 'report.md');
          if (!/^(?:report(?:-pr)?\.md|candidate\.patch|manifest\.json|events\.jsonl|(?:graph-manifest|run-config|acceptance-plan|acceptance-review)\.json|(?:reproduction|verification|candidates)\/.+\.(?:log|json|patch))$/.test(relative)) throw new Error('Artifact is outside the downloadable evidence allowlist');
          const content = await fs.readFile(await sourcePath(store.dir(id), relative));
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${path.basename(relative)}"`, 'cache-control': 'no-store' }); return res.end(content);
        }
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          let last = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0); if (!Number.isSafeInteger(last) || last < 0) last = 0;
          const replayAbort=new AbortController();
          let replaying = true, closed = false; const queued: RunEvent[] = [];
          let ping: ReturnType<typeof setInterval> | undefined;
          const cleanup = () => { if (closed) return; closed = true; replayAbort.abort(); if (ping) clearInterval(ping); store.off(id, listener); queued.length = 0; };
          const send = (event: RunEvent) => {
            if (closed || res.destroyed || res.writableEnded || event.seq <= last) return;
            last = event.seq; res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            if (res.writableLength > 2_000_000) { cleanup(); res.destroy(); }
          };
          const listener = (event: RunEvent) => { if (closed) return; if (replaying) {queued.push(event);if(queued.length>2000){cleanup();res.destroy();}} else send(event); };
          req.once('close', cleanup); res.once('close', cleanup); res.once('error', cleanup);
          store.on(id, listener);
          try {
            for await (const event of store.streamEvents(id,last,replayAbort.signal)) send(event);
            if (closed || res.destroyed || res.writableEnded) { cleanup(); return; }
            replaying = false; for (const event of queued) send(event); queued.length = 0;
            ping = setInterval(() => { if (closed || res.destroyed || res.writableEnded) cleanup(); else res.write(': heartbeat\n\n'); }, 15000);
          } catch (error) { cleanup(); throw error; }
          return;
        }
      }
      const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (assets[url.pathname] && req.method === 'GET') {
        const [file, mime] = assets[url.pathname]; res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); return res.end(await fs.readFile(path.join(publicDir, file)));
      }
      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : String(error) }, 400); else res.end();
    }
  });
  server.requestTimeout = 0; // agent turns and model streams can run for a long time
  return { server, pipeline, store, uiToken };
}
