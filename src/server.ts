import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pipeline } from './pipeline.ts';
import { Store } from './store.ts';
import { demo } from './demo.ts';
import { doctor } from './doctor.ts';
import { filterProviderTools } from './agent.ts';
import { safeRelative, sourcePath } from './files.ts';
import type { Config, RunEvent } from './types.ts';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
async function jsonBody(req: http.IncomingMessage, max = 4_000_000): Promise<any> {
  let size = 0; const parts: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('Request body is too large'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
export async function createServer(config: Config, options: { recover?: boolean; providerRequest?: typeof fetch } = {}) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 }); await fs.mkdir(config.repoRoot, { recursive: true });
  const tokenFile = path.join(config.stateDir, 'ui-token');
  const uiToken = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim() || randomBytes(32).toString('hex');
  await fs.writeFile(tokenFile, uiToken, { mode: 0o600 });
  const store = new Store(config.stateDir); const pipeline = new Pipeline(config, store);
  if (options.recover !== false) await pipeline.recover();
  const json = (res: http.ServerResponse, data: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
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
        const input = await jsonBody(req); const filtered = filterProviderTools(context.run, input);
        const expectedModel = config.model.slice(config.model.indexOf('/') + 1);
        if (input.model !== expectedModel) return json(res, { error: 'Model ID does not match the recorded configuration' }, 400);
        const key = (await fs.readFile(config.nvidiaSecret, 'utf8')).trim();
        if (!key || /\s/.test(key)) throw new Error('NVIDIA secret file is empty or invalid');
        // Per-request output is capped at the model's configured limit; total usage is only reported, never capped.
        const body = { ...filtered.body, max_tokens: Math.min(Number(input.max_tokens) || config.modelMaxOutput, config.modelMaxOutput) };
        await store.event(context.run, 'gateway', 'model_request', 'Approved outbound model tool list', { tools: filtered.names, removedTools: filtered.removed, model: input.model });
        const target = new URL(config.providerBaseUrl.endsWith('/') ? config.providerBaseUrl : config.providerBaseUrl + '/');
        if (target.protocol !== 'https:' || target.username || target.password) throw new Error('The NVIDIA endpoint must be a credential-free HTTPS URL');
        // One request lives until the run is cancelled or the agent disconnects (OpenCode then sends a new request).
        const request = new AbortController(); const stopRequest = () => request.abort(context.abort.signal.reason);
        context.abort.signal.addEventListener('abort', stopRequest, { once: true });
        res.on('close', () => { if (!res.writableEnded) request.abort(new Error('Agent disconnected from the model gateway')); });
        try {
          // Wait out rate limits (every 429) and transient provider/network failures (5xx or connection errors, 5 times) here
          // rather than hand them to OpenCode, whose own retries give up.
          let upstream: Response | undefined, failures = 0;
          for (let attempt = 0; ; attempt++) {
            let problem = ''; upstream = undefined;
            try {
              upstream = await (options.providerRequest || fetch)(target.href.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal });
              if ([401, 403, 404].includes(upstream.status)) context.providerRejected = `HTTP ${upstream.status}`; // bad key or unknown model
              if (upstream.status === 429) problem = 'HTTP 429';
              else if (upstream.status >= 500 && ++failures <= 5) problem = `HTTP ${upstream.status}`;
              else break;
              await upstream.body?.cancel().catch(() => {});
            } catch (error) {
              if (request.signal.aborted || ++failures > 5) return res.headersSent ? res.destroy() : json(res, { error: `Model provider unreachable: ${String(error)}` }, 502);
              problem = String(error);
            }
            const header = upstream?.headers.get('retry-after')?.trim();
            const seconds = Math.max(1, Math.min(30, header && Number.isFinite(Number(header)) ? Number(header) : 2 ** Math.min(attempt + 1, 5)));
            await store.event(context.run, 'gateway', problem === 'HTTP 429' ? 'rate_limited' : 'provider_retry', `Model ${problem}; retrying in ${seconds}s`);
            await sleep(seconds * 1000, undefined, { signal: request.signal });
          }
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
          if (!upstream.body) return res.end();
          let buffer = '', used = 0; const decoder = new TextDecoder();
          try {
            for await (const chunk of upstream.body) {
              res.write(chunk); buffer += decoder.decode(chunk, { stream: true });
              let index: number;
              while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).replace(/^data:\s*/, '').trim(); buffer = buffer.slice(index + 1);
                try { const data = JSON.parse(line); used = Math.max(used, Number(data.usage?.total_tokens || 0)); } catch {}
              }
              if (buffer.length > 1_000_000) buffer = buffer.slice(-100000);
            }
          } catch (error) {
            // A broken stream must reach OpenCode as a transport error, not as a silently truncated (retry-less) answer.
            await store.event(context.run, 'gateway', 'model_error', `Model stream interrupted: ${String(error)}`); return res.destroy();
          }
          try { const data = JSON.parse(buffer); used = Math.max(used, Number(data.usage?.total_tokens || 0)); } catch {}
          context.run.tokens += used;
          await store.save(context.run);
          await store.event(context.run, 'gateway', upstream.ok ? 'model_finished' : 'model_error', `Model HTTP ${upstream.status}; reported tokens ${used}`);
          return res.end();
        } finally { context.abort.signal.removeEventListener('abort', stopRequest); }
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
      const route = /^\/api\/runs\/([a-z0-9-]+)(?:\/(events|cancel|publish|artifact|diff))?$/.exec(url.pathname);
      if (route) {
        const [, id, action] = route; const run = await store.get(id);
        if (!action && req.method === 'GET') return json(res, run);
        if (action === 'cancel' && req.method === 'POST') { await pipeline.cancel(id); return json(res, { cancelling: true }); }
        if (action === 'publish' && req.method === 'POST') return json(res, await pipeline.retryPublication(id));
        if (action === 'diff' && req.method === 'GET') { const diff = await fs.readFile(path.join(store.dir(id), 'candidate.patch'), 'utf8').catch(async () => run.worktree ? (await pipeline.repository.git(run.worktree, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv'])).stdout : ''); return json(res, { diff }); }
        if (action === 'artifact' && req.method === 'GET') {
          const relative = safeRelative(url.searchParams.get('path') || 'report.md');
          if (!/^(?:report(?:-pr)?\.md|candidate\.patch|manifest\.json|events\.jsonl|graph-manifest\.json|(?:reproduction|verification|candidates)\/.+\.(?:log|json|patch))$/.test(relative)) throw new Error('Artifact is outside the downloadable evidence allowlist');
          const content = await fs.readFile(await sourcePath(store.dir(id), relative));
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${path.basename(relative)}"`, 'cache-control': 'no-store' }); return res.end(content);
        }
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          let last = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0); if (!Number.isSafeInteger(last) || last < 0) last = 0;
          let replaying = true; const queued: RunEvent[] = [];
          const send = (event: RunEvent) => { if (event.seq <= last) return; last = event.seq; res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); if (res.writableLength > 2_000_000) res.destroy(); };
          const listener = (event: RunEvent) => { if (replaying) queued.push(event); else send(event); };
          store.on(id, listener);
          for (const event of await store.events(id, last)) send(event); replaying = false; for (const event of queued) send(event);
          const ping = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          req.on('close', () => { clearInterval(ping); store.off(id, listener); }); return;
        }
      }
      const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (assets[url.pathname] && req.method === 'GET') {
        const [file, mime] = assets[url.pathname]; res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); return res.end(await fs.readFile(path.join(publicDir, file)));
      }
      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : String(error) }, 400); else res.end();
    }
  });
  server.requestTimeout = 0; // agent turns and model streams can run for a long time
  return { server, pipeline, store, uiToken };
}
