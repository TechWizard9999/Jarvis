import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Manifest, RunEvent, RunInput, Stage } from './types.ts';

export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}
export interface EventPageOptions { before?: number; after?: number; limit?: number; search?: string; stage?: string; source?: string; errors?: boolean; }
export interface EventPage { events: RunEvent[]; hasOlder: boolean; before?: number; latestSeq: number; }
interface EventOffset { seq: number; offset: number; length: number; stage: string; source: string; error: boolean; }
interface EventIndex { entries: EventOffset[]; size: number; latestSeq: number; needsNewline: boolean; }
const isError = (event: RunEvent) => /error|fail|reject|blocked/i.test(`${event.kind} ${event.message}`);
export class Store extends EventEmitter {
  root: string;
  private queues = new Map<string, Promise<unknown>>();
  private saves = new Map<string, Promise<unknown>>();
  private revisions = new Map<string, number>();
  private indexes = new Map<string, Promise<EventIndex>>();
  constructor(root: string) { super(); this.root = root; }
  dir(id: string) { if (!/^[a-z0-9-]{8,80}$/.test(id)) throw new Error('Invalid run ID'); return path.join(this.root, 'runs', id); }
  async create(input: RunInput): Promise<Manifest> {
    const id = `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const run: Manifest = { id, input, createdAt: now, updatedAt: now, stage: 'queued', tools: 0, tokens: 0, attempt: 0, checks: [], graphReady: false, graphStale: false, demo: input.mode === 'demo' };
    await fs.mkdir(this.dir(id), { recursive: true }); await this.save(run); return run;
  }
  save(run: Manifest): Promise<void> {
    run.updatedAt = new Date().toISOString();
    // Capture at invocation, before any queued write or filesystem await can observe later mutations.
    const snapshot = structuredClone(run) as Manifest & { revision?: number };
    const file = path.join(this.dir(run.id), 'manifest.json');
    const pending = (this.saves.get(run.id) || Promise.resolve()).catch(() => {}).then(async () => {
      let revision = this.revisions.get(run.id);
      if (revision === undefined) {
        const durable = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
        revision = durable ? Number(JSON.parse(durable).revision || 0) : 0;
      }
      snapshot.revision = Math.max(revision, snapshot.revision || 0) + 1;
      await atomicJson(file, snapshot);
      this.revisions.set(run.id, snapshot.revision);
      (run as Manifest & { revision?: number }).revision = Math.max((run as Manifest & { revision?: number }).revision || 0, snapshot.revision);
    });
    this.saves.set(run.id, pending);
    void pending.finally(() => { if (this.saves.get(run.id) === pending) this.saves.delete(run.id); }).catch(() => {});
    return pending;
  }
  async get(id: string): Promise<Manifest> { return JSON.parse(await fs.readFile(path.join(this.dir(id), 'manifest.json'), 'utf8')); }
  async list(): Promise<Manifest[]> {
    const entries = await fs.readdir(path.join(this.root, 'runs')).catch(() => []);
    const values = await Promise.all(entries.map(id => this.get(id).catch(() => null)));
    return values.filter((x): x is Manifest => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private eventIndex(id: string): Promise<EventIndex> {
    const existing = this.indexes.get(id); if (existing) return existing;
    const pending = (async () => {
      const index: EventIndex = { entries: [], size: 0, latestSeq: 0, needsNewline: false };
      let buffered = Buffer.alloc(0), offset = 0;
      try {
        for await (const chunk of createReadStream(path.join(this.dir(id), 'events.jsonl'))) {
          buffered = Buffer.concat([buffered, chunk as Buffer]); let newline: number;
          while ((newline = buffered.indexOf(10)) !== -1) {
            const line = buffered.subarray(0, newline); const length = newline + 1;
            try {
              const event = JSON.parse(line.toString('utf8')) as RunEvent;
              if (Number.isSafeInteger(event.seq) && event.seq > index.latestSeq) {
                index.entries.push({ seq: event.seq, offset, length, stage: event.stage, source: event.source, error: isError(event) }); index.latestSeq = event.seq;
              }
            } catch { /* A partial or corrupt record cannot become replay evidence. */ }
            offset += length; buffered = buffered.subarray(length);
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (buffered.length) {
        index.needsNewline = true;
        try {
          const event = JSON.parse(buffered.toString('utf8')) as RunEvent;
          if (Number.isSafeInteger(event.seq) && event.seq > index.latestSeq) {
            index.entries.push({ seq: event.seq, offset, length: buffered.length, stage: event.stage, source: event.source, error: isError(event) }); index.latestSeq = event.seq;
          }
        } catch { /* Retain the partial bytes, then isolate them before the next append. */ }
      }
      index.size = offset + buffered.length; return index;
    })();
    this.indexes.set(id, pending);
    void pending.catch(() => { if (this.indexes.get(id) === pending) this.indexes.delete(id); });
    return pending;
  }
  async eventPage(id: string, options: EventPageOptions = {}): Promise<EventPage> {
    const limit = Math.min(1000, Math.max(1, Math.floor(options.limit || 200)));
    const index = await this.eventIndex(id);
    const candidates = index.entries.filter(entry => (options.before === undefined || entry.seq < options.before) &&
      (options.after === undefined || entry.seq > options.after) && (!options.stage || entry.stage === options.stage) &&
      (!options.source || entry.source === options.source) && (!options.errors || entry.error));
    if (!candidates.length) return { events: [], hasOlder: false, latestSeq: index.latestSeq };
    const forward = options.after !== undefined && options.before === undefined;
    const ordered = forward ? candidates : candidates.slice().reverse();
    const handle = await fs.open(path.join(this.dir(id), 'events.jsonl'), 'r'); const events: RunEvent[] = [];
    try {
      for (const entry of ordered) {
        const buffer = Buffer.alloc(entry.length); await handle.read(buffer, 0, entry.length, entry.offset);
        const event = JSON.parse(buffer.toString('utf8')) as RunEvent;
        if (options.search && !JSON.stringify(event).toLocaleLowerCase().includes(options.search.toLocaleLowerCase())) continue;
        events.push(event); if (events.length > limit) break;
      }
    } finally { await handle.close(); }
    const extra = events.length > limit; if (extra) events.pop(); if (!forward) events.reverse();
    const before = events[0]?.seq;
    return { events, hasOlder: forward ? index.entries.some(entry => entry.seq < (before || 0)) : extra, ...(before === undefined ? {} : { before }), latestSeq: index.latestSeq };
  }
  async *streamEvents(id: string, after = 0, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    while (true) {
      signal?.throwIfAborted(); const page = await this.eventPage(id, { after, limit: 500 }); signal?.throwIfAborted();
      for (const event of page.events) { signal?.throwIfAborted(); yield event; after = event.seq; }
      if (page.events.length < 500) return;
    }
  }
  async events(id: string, after = 0): Promise<RunEvent[]> {
    const events: RunEvent[] = []; for await (const event of this.streamEvents(id, after)) events.push(event); return events;
  }
  async event(run: Manifest, source: string, kind: string, message: string, data?: unknown): Promise<RunEvent> {
    const stage = run.stage, capturedData = data === undefined ? undefined : structuredClone(data);
    const prior = this.queues.get(run.id) || Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      const index = await this.eventIndex(run.id);
      const event: RunEvent = { seq: index.latestSeq + 1, runId: run.id, time: new Date().toISOString(), stage, source, kind, message, ...(capturedData === undefined ? {} : { data: capturedData }) };
      const line = JSON.stringify(event) + '\n';
      if (index.needsNewline) {
        await fs.appendFile(path.join(this.dir(run.id), 'events.jsonl'), '\n', { mode: 0o600 }); index.size++; index.needsNewline = false;
      }
      await fs.appendFile(path.join(this.dir(run.id), 'events.jsonl'), line, { mode: 0o600 });
      const length = Buffer.byteLength(line); index.entries.push({ seq: event.seq, offset: index.size, length, stage, source, error: isError(event) }); index.size += length; index.latestSeq = event.seq;
      this.emit(run.id, event); return event;
    });
    this.queues.set(run.id, pending);
    void pending.finally(() => { if (this.queues.get(run.id) === pending) this.queues.delete(run.id); }).catch(() => {}); return pending;
  }
  async stage(run: Manifest, stage: Stage, message: string) {
    const now = new Date().toISOString();
    run.stageTimes ||= [{ stage: run.stage, startedAt: run.createdAt }];
    const previous = run.stageTimes.at(-1);
    if (previous?.stage !== stage) {
      if (previous && !previous.finishedAt) previous.finishedAt = now;
      run.stageTimes.push({ stage, startedAt: now });
    }
    run.stage = stage; await this.save(run); await this.event({ ...run, stage }, 'controller', 'stage', message);
  }
}
