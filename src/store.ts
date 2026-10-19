import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Manifest, RunEvent, RunInput, Stage } from './types.ts';

export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}
export class Store extends EventEmitter {
  root: string; private sequences = new Map<string, number>(); private queues = new Map<string, Promise<unknown>>();
  constructor(root: string) { super(); this.root = root; }
  dir(id: string) { if (!/^[a-z0-9-]{8,80}$/.test(id)) throw new Error('Invalid run ID'); return path.join(this.root, 'runs', id); }
  async create(input: RunInput): Promise<Manifest> {
    const id = `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const run: Manifest = { id, input, createdAt: now, updatedAt: now, stage: 'queued', tools: 0, tokens: 0, attempt: 0, checks: [], graphReady: false, graphStale: false, demo: input.mode === 'demo' };
    await fs.mkdir(this.dir(id), { recursive: true }); await this.save(run); return run;
  }
  async save(run: Manifest) { run.updatedAt = new Date().toISOString(); await atomicJson(path.join(this.dir(run.id), 'manifest.json'), run); }
  async get(id: string): Promise<Manifest> { return JSON.parse(await fs.readFile(path.join(this.dir(id), 'manifest.json'), 'utf8')); }
  async list(): Promise<Manifest[]> {
    const entries = await fs.readdir(path.join(this.root, 'runs')).catch(() => []);
    const values = await Promise.all(entries.map(id => this.get(id).catch(() => null)));
    return values.filter((x): x is Manifest => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async events(id: string, after = 0): Promise<RunEvent[]> {
    const content = await fs.readFile(path.join(this.dir(id), 'events.jsonl'), 'utf8').catch(() => '');
    return content.split('\n').filter(Boolean).flatMap(line => { try { const e = JSON.parse(line) as RunEvent; return e.seq > after ? [e] : []; } catch { return []; } });
  }
  async event(run: Manifest, source: string, kind: string, message: string, data?: unknown): Promise<RunEvent> {
    const prior = this.queues.get(run.id) || Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      let seq = this.sequences.get(run.id);
      if (seq === undefined) seq = (await this.events(run.id)).at(-1)?.seq || 0;
      const event: RunEvent = { seq: seq + 1, runId: run.id, time: new Date().toISOString(), stage: run.stage, source, kind, message, ...(data === undefined ? {} : { data }) };
      await fs.appendFile(path.join(this.dir(run.id), 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
      this.sequences.set(run.id, event.seq); this.emit(run.id, event); return event;
    });
    this.queues.set(run.id, pending); return pending;
  }
  async stage(run: Manifest, stage: Stage, message: string) { run.stage = stage; await this.save(run); await this.event(run, 'controller', 'stage', message); }
}
