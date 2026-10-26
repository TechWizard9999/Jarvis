import { providerBody, providerRetrySeconds, rejectsReasoningBudgetError, type ModelTurnPurpose } from './provider.ts';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pipeline } from './pipeline.ts';
import { Store, atomicJson } from './store.ts';
import { providerFrames, frameError, frameOutput } from './provider-stream.ts';
import { ProviderCooldown, providerError, interruptedProviderError, recordProviderFailure, providerAttemptHeaders, type ProviderError, type ProviderAttemptRecord } from './provider-health.ts';
import { demo } from './demo.ts';
import { doctor } from './doctor.ts';
import { filterProviderTools } from './agent.ts';
import { safeRelative, sourcePath } from './files.ts';
import type { Config, RunEvent, Manifest } from './types.ts';

const hashProviderIdentity = (endpoint: string, key: string) => createHash('sha256').update(JSON.stringify([endpoint.replace(/\/$/, ''),key])).digest('hex');
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
// The NVIDIA key and chat endpoint, shared by the run gateway and the direct chat API.
async function providerKey(config: Config) {
  const key = (await fs.readFile(config.nvidiaSecret, 'utf8')).trim();
  if (!key || /\s/.test(key)) throw new Error('NVIDIA secret file is empty or invalid'); return key;
}
function providerEndpoint(config: Config) {
  const target = new URL(config.providerBaseUrl.endsWith('/') ? config.providerBaseUrl : config.providerBaseUrl + '/');
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('The NVIDIA endpoint must be a credential-free HTTPS URL');
  return target.href.replace(/\/$/, '') + '/chat/completions';
}
class ChatProviderError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
// Direct model access outside a repair run. Keep prompts and answers out of durable run evidence.
async function chat(config: Config, input: any, signal: AbortSignal, providerRequest: typeof fetch = fetch, silenceMs = 300_000) {
  const roles = ['system', 'user', 'assistant'];
  const messages = Array.isArray(input?.messages) ? input.messages : typeof input?.prompt === 'string' && input.prompt.trim() ? [...(typeof input.system === 'string' && input.system ? [{ role: 'system', content: input.system }] : []), { role: 'user', content: input.prompt }] : [];
  if (!messages.length || messages.length > 200 || !messages.every((m: any) => roles.includes(m?.role) && typeof m.content === 'string') || JSON.stringify(messages).length > 1_000_000) throw new Error('Provide a non-empty "prompt" (optionally "system"), or "messages": [{"role":"system|user|assistant","content":"..."}]');
  const model = input.model === undefined ? config.model.slice(config.model.indexOf('/') + 1) : String(input.model);
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(model)) throw new Error('Invalid model ID');
  if (input.max_tokens !== undefined && (!Number.isSafeInteger(input.max_tokens) || input.max_tokens <= 0)) throw new Error('max_tokens must be a positive finite integer');
  const body = { model, messages: messages.map((m: any) => ({ role: m.role, content: m.content })), max_tokens: Math.min(input.max_tokens ?? config.modelMaxOutput, config.modelMaxOutput), ...(Number.isFinite(input.temperature) ? { temperature: Number(input.temperature) } : {}), stream: true, stream_options: { include_usage: true } };
  const key = await providerKey(config), endpoint = providerEndpoint(config);
  for (let attempt = 0; attempt < 4; attempt++) {
    let timer: NodeJS.Timeout | undefined, meaningful = false; const idle = new AbortController();
    const quiet = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('Model provider stopped producing output')), silenceMs); };
    try {
      quiet();
      const response = await providerRequest(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, idle.signal]) });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        clearTimeout(timer); await response.body?.cancel().catch(() => {});
        await sleep(providerRetrySeconds(response.headers, attempt) * 1000, undefined, { signal }); continue;
      }
      let answer = '', reasoning = '', finishReason = '', usage: unknown, protocolDone = false;
      // Some compatible endpoints omit the SSE content type; the requested stream still uses SSE framing.
      const streaming = !/application\/json/i.test(response.headers.get('content-type') || '');
      const framed = streaming ? new Response(response.body, { status: response.status, headers: { 'content-type': 'text/event-stream' } }) : response;
      for await (const frame of providerFrames(framed)) {
        const error = frameError(frame, response.status);
        if (error) throw new ChatProviderError(response.status >= 400 ? response.status : 502, error.message);
        const output = frameOutput(frame.data); meaningful ||= output.meaningful;
        if (output.meaningful || output.finish || frame.done) quiet();
        const choice = frame.data?.choices?.[0], delta = choice?.delta || choice?.message;
        if (typeof delta?.content === 'string') answer += delta.content;
        if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
        else if (typeof delta?.reasoning === 'string') reasoning += delta.reasoning;
        finishReason = choice?.finish_reason || finishReason; usage = frame.data?.usage || usage;
        if (frame.done) { protocolDone = true; break; }
      }
      if (!response.ok) throw new ChatProviderError(response.status, providerError(undefined, response.status)!.message);
      if (streaming && (!meaningful || !protocolDone && !finishReason)) throw new ChatProviderError(502, interruptedProviderError().message);
      const think = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(answer); if (think) { reasoning += think[1]; answer = answer.slice(think[0].length); }
      return { model, answer: answer.trim(), ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}), finishReason, usage };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ChatProviderError) throw error;
      if (meaningful || attempt === 3) throw new ChatProviderError(502, meaningful ? interruptedProviderError().message : 'Model provider connection failed.');
      clearTimeout(timer); await sleep(providerRetrySeconds(undefined, attempt) * 1000, undefined, { signal });
    } finally { clearTimeout(timer); }
  }
  throw new ChatProviderError(502, 'Model provider connection failed.');
}
export async function createServer(config: Config, options: { recover?: boolean; providerRequest?: typeof fetch; providerSilenceMs?: number } = {}) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 }); await fs.mkdir(config.repoRoot, { recursive: true });
  const tokenFile = path.join(config.stateDir, 'ui-token');
  const uiToken = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim() || randomBytes(32).toString('hex');
  await fs.writeFile(tokenFile, uiToken, { mode: 0o600 });
  const store = new Store(config.stateDir); const pipeline = new Pipeline(config, store);
  // Only a validated exact rejection changes capability; cache survives a controller restart.
  const capabilityFile = path.join(config.stateDir, 'provider-capabilities.json');
  const unsupportedBudgets = new Map<string, { observedAt: string; endpoint: string; model: string }>();
  const capabilityKeyFor = (endpoint: string, model: string) => JSON.stringify([endpoint.replace(/\/$/, ''),model]);
  const cachedFile = await fs.stat(capabilityFile).catch(() => undefined);
  if(cachedFile && cachedFile.size <= 64_000) {
    const cached = await fs.readFile(capabilityFile,'utf8').then(JSON.parse).catch(() => undefined);
    if(cached?.version === 1 && Array.isArray(cached.entries) && cached.entries.length <= 100) for(const entry of cached.entries) {
      if(!entry || entry.reason !== 'nvidia_v2_model_runner_unsupported' || typeof entry.endpoint !== 'string' || !['nvidia/nemotron-3-ultra-550b-a55b','nvidia/nemotron-3.5-lightning-30b-a3b'].includes(entry.model) || typeof entry.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.observedAt) || !Number.isFinite(Date.parse(entry.observedAt)))continue;
      try {const endpoint=new URL(entry.endpoint);if(endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)continue;unsupportedBudgets.set(capabilityKeyFor(endpoint.href,entry.model),{endpoint:endpoint.href,model:entry.model,observedAt:entry.observedAt});}catch {}
    }
  }
  const cooldown = new ProviderCooldown();
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
        if(context.providerFailure?.circuitOpen) return json(res,{error:{type:'provider_recovery_paused',message:'Model provider recovery paused after repeated failures or partial output. Evidence is preserved; inspect provider health before a new run.',code:'provider_recovery_paused'}},409);
        const key = await providerKey(config);
        // Per-request output is capped at the model's configured limit; total usage is only reported, never capped.
        const turnPurpose = context.agent.turnPurpose || context.phase;
        const turnPurposeSource = context.agent.turnPurpose ? 'active_turn' : 'stage_fallback';
        const body = providerBody(filtered.body,config,turnPurpose as ModelTurnPurpose);
        const target = new URL(config.providerBaseUrl.endsWith('/') ? config.providerBaseUrl : config.providerBaseUrl + '/');
        if (target.protocol !== 'https:' || target.username || target.password) throw new Error('The NVIDIA endpoint must be a credential-free HTTPS URL');
        const requestedSettings = providerSettings(body);
        const capabilityKey = capabilityKeyFor(target.href, body.model);
        const cooldownKey = hashProviderIdentity(target.href, key);
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
        let completed = false, interrupted = false, meaningfulOutput = false, usableOutput = false;
        record.transportComplete = false; record.semanticComplete = false; record.outputDelivered = false; record.attemptRecords = [];
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
        const failure = (error: ProviderError) => {
          const value=recordProviderFailure(context.providerFailure,error,{requestId:record.id,httpStatus:record.httpStatus,meaningfulOutput,usableOutput,identity:JSON.stringify([capabilityKey,record.settingsSha256])});
          context.providerFailure=value;record.providerError=value;return value;
        };
        const request = new AbortController(); const stopRequest = () => request.abort(context.abort.signal.reason);
        const silence = options.providerSilenceMs ?? 300_000; let idle = new AbortController(), idleTimer: NodeJS.Timeout | undefined;
        const quiet = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error('Model provider stopped producing output')), silence); };
        context.abort.signal.addEventListener('abort', stopRequest, { once: true });if(context.abort.signal.aborted || res.destroyed)stopRequest();
        res.on('close', () => { if (!res.writableEnded) request.abort(new Error('Agent disconnected from the model gateway')); });
        const omitBudget = async () => {
          const observedAt = new Date().toISOString();unsupportedBudgets.set(capabilityKey,{observedAt,endpoint:target.href,model:body.model});
          await atomicJson(capabilityFile,{version:1,entries:[...unsupportedBudgets.values()].map(value=>({...value,reason:'nvidia_v2_model_runner_unsupported'}))});
          delete body.reasoning_budget;
          record.parameterOmissions = [{parameter:'reasoning_budget',reason:'nvidia_v2_model_runner_unsupported',source:'provider_rejection',observedAt}];
          record.answerReserve='unavailable';record.settings=providerSettings(body);record.settingsSha256=hash(record.settings);
          await store.save(context.run);
          await store.event(context.run,'gateway','provider_capability_fallback','NVIDIA V2 runner rejected reasoning_budget; retrying once without it. Final-answer/tool-call reserve is unavailable.',{requestId:record.id,parameterOmissions:record.parameterOmissions,requestedSettings,requestedSettingsSha256:record.requestedSettingsSha256,settings:record.settings,settingsSha256:record.settingsSha256,answerReserve:record.answerReserve});
        };
        const errorResponse = (error: ProviderError) => {
          const value={error:{message:error.message,type:error.type || error.kind,code:error.code ?? error.kind}};
          if(res.headersSent){res.write(`event: error\ndata: ${JSON.stringify(value)}\n\n`);return res.end();}
          return json(res,value,record.httpStatus && record.httpStatus>=400 ? record.httpStatus : 502);
        };
        try {
          let transientFailures=0,capabilityRetried=false;
          for (;;) {
            await cooldown.wait(cooldownKey,request.signal);request.signal.throwIfAborted();
            idle = new AbortController(); quiet();
            const startedAt=new Date().toISOString();record.attempts++;
            let upstream: Response;
            let attempt: ProviderAttemptRecord={attempt:record.attempts,startedAt,finishedAt:startedAt,latencyMs:0,retryOwner:'gateway'};
            const finishAttempt=()=>{clearTimeout(idleTimer);attempt.finishedAt=new Date().toISOString();attempt.latencyMs=Math.max(0,Date.parse(attempt.finishedAt)-Date.parse(attempt.startedAt));};
            record.attemptRecords.push(attempt);
            try {
              upstream=await (options.providerRequest || fetch)(target.href.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([request.signal,idle.signal])});
              record.httpStatus=upstream.status;attempt.httpStatus=upstream.status;Object.assign(attempt,providerAttemptHeaders(upstream.headers,key));
            } catch {
              finishAttempt();if(request.signal.aborted)throw request.signal.reason;
              const error:ProviderError={kind:'provider_error',type:'network_error',message:'Model provider connection failed.',retryable:true};
              if(++transientFailures>=4){attempt.error=failure(error);return errorResponse(error);}
              const seconds=providerRetrySeconds(undefined,transientFailures-1);attempt.retryAfterSeconds=seconds;cooldown.defer(cooldownKey,seconds);
              await store.event(context.run,'gateway','provider_retry',`Model connection failed; retrying in ${seconds}s`,{requestId:record.id,attempt:attempt.attempt,retryOwner:'gateway',seconds});continue;
            }
            if([401,403,404].includes(upstream.status))context.providerRejected=`HTTP ${upstream.status}`;
            if(upstream.status===429 || upstream.status>=500) {
              if(++transientFailures<4) {
                finishAttempt();const seconds=providerRetrySeconds(upstream.headers,transientFailures-1);attempt.retryAfterSeconds=seconds;cooldown.defer(cooldownKey,seconds);
                await upstream.body?.cancel().catch(()=>{});
                await store.event(context.run,'gateway',upstream.status===429?'rate_limited':'provider_retry',`Model HTTP ${upstream.status}; retrying in ${seconds}s`,{requestId:record.id,attempt:attempt.attempt,retryOwner:'gateway',seconds,httpStatus:upstream.status,...providerAttemptHeaders(upstream.headers,key)});continue;
              }
              // Preserve the final Retry-After across the SDK's next logical request too.
              cooldown.defer(cooldownKey,providerRetrySeconds(upstream.headers,transientFailures-1));
            }
            const sse=/text\/event-stream/i.test(upstream.headers.get('content-type') || '');
            let pending='',terminal=false,fallback=false,protocolDone=false;
            try {
              for await(const frame of providerFrames(upstream)) {
                if(res.destroyed || res.writableEnded || request.signal.aborted)throw new Error('Model response disconnected');
                readUsage(frame.data);
                const error=frameError(frame,upstream.status);
                if(error) {
                  if(!capabilityRetried && !meaningfulOutput && rejectsReasoningBudgetError(frame.data,upstream.status,body)) {
                    finishAttempt();capabilityRetried=true;await omitBudget();fallback=true;break;
                  }
                  if(!sse)record.transportComplete=true;
                  finishAttempt();attempt.error=failure(error);return errorResponse(error);
                }
                const output=frameOutput(frame.data);if(output.meaningful || output.finish || frame.done)quiet();meaningfulOutput ||= output.meaningful;usableOutput ||= output.usable;
                if(frame.done && !meaningfulOutput && !terminal) {
                  finishAttempt();const error:ProviderError={kind:'provider_error',type:'empty_generation',message:'Model provider ended the stream without a generation.',retryable:true};attempt.error=failure(error);return errorResponse(error);
                }
                terminal ||= !!frame.done || output.finish;
                pending+=frame.text;
                if(pending.length>4_000_000)throw new Error('Provider prelude exceeded the supported size');
                if(meaningfulOutput || !sse) {
                  if(!res.headersSent)res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type') || 'application/json','cache-control':'no-store'});
                  record.outputDelivered ||= meaningfulOutput;res.write(pending);pending='';
                }
                if(frame.done){protocolDone=true;break;}
              }
              if(fallback)continue;
              record.transportComplete=!protocolDone;finishAttempt();
              if(sse && !terminal) {interrupted=true;const error=interruptedProviderError();attempt.error=failure(error);return res.destroy();}
              if(upstream.status>=400) {const error=providerError(undefined,upstream.status)!;attempt.error=failure(error);return errorResponse(error);}
              record.semanticComplete=true;completed=true;
              if(usableOutput)context.providerFailure=undefined;
              if(!res.headersSent)res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type') || 'application/json','cache-control':'no-store'});
              return res.end(pending);
            } catch {
              finishAttempt();interrupted=true;
              if(!request.signal.aborted)attempt.error=failure(interruptedProviderError());
              return res.destroy();
            }
          }
        } finally {
          clearTimeout(idleTimer); context.abort.signal.removeEventListener('abort', stopRequest);
          record.finishedAt=new Date().toISOString();record.latencyMs=Math.max(0,Date.parse(record.finishedAt)-Date.parse(record.startedAt));
          record.status=completed?'completed':interrupted || request.signal.aborted?'interrupted':'failed';
          if(completed && record.totalTokens!==undefined)record.usage='complete';
          context.run.tokens+=record.totalTokens ?? 0;
          await store.save(context.run);
          await store.event(context.run,'gateway',record.status==='completed'?'model_finished':'model_error',`Model ${record.httpStatus?`HTTP ${record.httpStatus}`:record.status}; generation ${record.status}; reported tokens ${record.totalTokens ?? 'unknown'} (${record.usage})`,{requestId:record.id,...record});
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
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const request = new AbortController(); res.on('close', () => { if (!res.writableEnded) request.abort(new Error('Client disconnected')); });
        try { return json(res, await chat(config, await jsonBody(req), request.signal, options.providerRequest, options.providerSilenceMs)); }
        catch (error) { if (error instanceof ChatProviderError) return json(res, { error: error.message, providerStatus: error.status }, 502); throw error; }
      }
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
          const replayAbort = new AbortController();
          let replaying = true, pumping = false, closed = false; const queued: RunEvent[] = [];
          let ping: ReturnType<typeof setInterval> | undefined;
          const cleanup = () => { if (closed) return; closed = true; replayAbort.abort(); if (ping) clearInterval(ping); store.off(id, listener); queued.length = 0; };
          const send = async (event: RunEvent) => {
            if (closed || res.destroyed || res.writableEnded || event.seq <= last) return;
            last = event.seq;
            // Pause replay and live delivery at socket backpressure, allowing arbitrarily long durable histories.
            if (!res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) await new Promise<void>(resolve => {
              const done = () => { res.off('drain', done); res.off('close', done); res.off('error', done); resolve(); };
              res.once('drain', done); res.once('close', done); res.once('error', done);
              if (closed || res.destroyed || res.writableEnded) done();
            });
          };
          const pump = async () => {
            if (pumping || replaying || closed) return;
            pumping = true;
            try { while (queued.length && !closed) await send(queued.shift()!); }
            catch { cleanup(); res.destroy(); }
            finally { pumping = false; }
          };
          const listener = (event: RunEvent) => {
            if (closed) return;
            queued.push(event);
            if (queued.length > 2000) { cleanup(); res.destroy(); return; }
            void pump();
          };
          req.once('close', cleanup); res.once('close', cleanup); res.once('error', cleanup);
          store.on(id, listener);
          try {
            for await (const event of store.streamEvents(id, last, replayAbort.signal)) await send(event);
            if (closed || res.destroyed || res.writableEnded) { cleanup(); return; }
            replaying = false; void pump();
            ping = setInterval(() => { if (closed || res.destroyed || res.writableEnded) cleanup(); else if (!pumping) res.write(': heartbeat\n\n'); }, 15000);
          } catch (error) { cleanup(); throw error; }
          return;
        }
      }
      const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (assets[url.pathname] && req.method === 'GET') {
        const [file, mime] = assets[url.pathname]; res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); return res.end(await fs.readFile(path.join(publicDir, file)));
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : String(error) }, 400); else res.end();
    }
  });
  server.requestTimeout = 0; // agent turns and model streams can run for a long time
  return { server, pipeline, store, uiToken };
}
