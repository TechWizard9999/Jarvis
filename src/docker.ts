import fs from 'node:fs/promises';
import path from 'node:path';
import { exec, checked } from './process.ts';
import { hash } from './files.ts';
import type { Config, Manifest } from './types.ts';
import type { Store } from './store.ts';

export class Docker {
  config: Config; store: Store; private containers = new Map<string, Set<string>>();
  constructor(config: Config, store: Store) { this.config = config; this.store = store; }
  async command(args: string[], run?: Manifest, signal?: AbortSignal, timeout = this.config.commandTimeoutMs) {
    return exec(this.config.docker, args, { timeoutMs: timeout, signal,
      onOutput: run ? (text, stream) => { void this.store.event(run, 'docker', 'output', text, { stream }).catch(() => {}); } : undefined });
  }
  async imageId(image: string) { return checked(await this.command(['image', 'inspect', '--format', '{{.Id}}', image]), `Image ${image} is missing; run ./bugfix build`); }
  private track(run: Manifest, name: string) { const set = this.containers.get(run.id) || new Set(); set.add(name); this.containers.set(run.id, set); }
  async startWorker(run: Manifest, source: string, image = run.image!, readonly = true, suffix = 'worker') {
    const name = `bugfix-${run.id}-${suffix}`;
    // --init: PID 1 must reap orphans; tests that spawn git (which detaches auto-maintenance) otherwise leave zombies until the pids limit is hit.
    const args = ['run', '--detach', '--init', '--name', name, '--label', `bugfix.run=${run.id}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', this.config.memory, '--cpus', this.config.cpus,
      '--env', 'CARGO_BUILD_JOBS=1', '--env', 'CARGO_NET_OFFLINE=true', '--env', 'RUST_TEST_THREADS=1', '--env', 'CARGO_TARGET_DIR=/build/target', '--env', 'GRAPHIFY_OUT=/build/graphify-out', '--env', 'GRAPHIFY_BACKEND=none', '--env', 'GRAPHIFY_NO_AUTO_REFRESH=1',
      '--mount', `type=bind,source=${source},target=/workspace${readonly ? ',readonly' : ''}`, '--workdir', '/workspace', image, 'sleep', 'infinity'];
    checked(await this.command(args), 'Start isolated repository container'); this.track(run, name); return name;
  }
  // The time limit is enforced inside the container (coreutils `timeout`), so a hung build or test is killed without
  // killing the worker container that later checks still need. Cancelling the run still stops the container.
  async inContainer(run: Manifest, container: string, argv: string[], signal?: AbortSignal, timeoutMs = this.config.commandTimeoutMs) {
    const result = await this.command(['exec', '--workdir', '/workspace', container, 'timeout', '--kill-after=30', String(Math.ceil(timeoutMs / 1000)), ...argv], run, signal, timeoutMs + 90_000);
    if (result.code === 124 || result.code === 137) result.timedOut = true;
    if (signal?.aborted) await this.command(['kill', container]).catch(() => {});
    return result;
  }
  async remove(name: string) { await this.command(['rm', '--force', name]).catch(() => {}); }
  async cleanup(run: Manifest) {
    const tracked = this.containers.get(run.id) || new Set<string>();
    for (const name of tracked) await this.remove(name); this.containers.delete(run.id);
  }
  async stopOrphans(run: Manifest) {
    const result = await this.command(['ps', '-aq', '--filter', `label=bugfix.run=${run.id}`]);
    for (const id of result.stdout.split(/\s+/).filter(x => /^[a-f0-9]{12,64}$/.test(x))) await this.remove(id);
  }
  async prepare(run: Manifest, base: string, signal: AbortSignal) {
    const workerId = await this.imageId(this.config.workerImage);
    const toolchain = checked(await this.command(['run', '--rm', '--network', 'none', this.config.workerImage, 'rustc', '--version'], run, signal), 'Inspect worker Rust compiler');
    const lock = await fs.readFile(path.join(base, 'Cargo.lock'));
    const key = hash(JSON.stringify({ base: run.baseSha, lock: hash(lock), workerId, toolchain: this.config.rustToolchain, profile: this.config.profile }));
    const image = `bugfix-cache:${key.slice(0, 24)}`;
    const cached = await this.command(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!cached.code) { run.image = image; run.imageId = cached.stdout.trim(); run.toolchain = toolchain; await this.store.event(run, 'cache', 'hit', 'Reusing controller-prepared baseline cache'); return; }
    // Download only in a separate container. No repository build script runs while network is enabled.
    const fetcher = `bugfix-${run.id}-fetch`;
    const out = path.join(this.store.dir(run.id), 'dependency-seed'); await fs.mkdir(out, { recursive: true });
    this.track(run, fetcher);
    // crates.io downloads can be slow or flaky: a longer limit and up to 3 tries before the environment counts as blocked.
    let fetched!: Awaited<ReturnType<Docker['command']>>;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.remove(fetcher);
      fetched = await this.command(['run', '--init', '--name', fetcher, '--label', `bugfix.run=${run.id}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', this.config.memory,
      '--mount', `type=bind,source=${base},target=/workspace,readonly`, '--mount', `type=bind,source=${out},target=/seed`,
      '--workdir', '/workspace', this.config.workerImage, 'python3', '/opt/bugfix/prepare.py', 'fetch'], run, signal, this.config.commandTimeoutMs * 3);
      if (!fetched.code && !fetched.timedOut || signal?.aborted) break;
      await this.store.event(run, 'environment', 'retry', `Dependency fetch failed (attempt ${attempt}/3); retrying`);
    }
    checked(fetched, 'Fetch locked Cargo dependencies'); await this.remove(fetcher);
    const builder = await this.startWorker(run, base, this.config.workerImage, true, 'cache');
    checked(await this.command(['cp', `${out}/.`, `${builder}:/opt/cargo/`], run, signal), 'Seed dependency cache');
    checked(await this.inContainer(run, builder, ['python3', '/opt/bugfix/prepare.py', 'baseline', JSON.stringify(this.config.profile.checks)], signal, this.config.commandTimeoutMs * 4), 'Baseline profile must pass before attempting a repair');
    checked(await this.command(['commit', '--change', 'WORKDIR /workspace', builder, image], run, signal), 'Save immutable trusted cache');
    await this.remove(builder);
    run.image = image; run.imageId = await this.imageId(image); run.toolchain = toolchain;
    await this.store.event(run, 'cache', 'ready', 'Baseline passed; trusted cache image saved', { imageId: run.imageId });
  }
  async startAgent(run: Manifest, trustedDir: string, secretDir: string, password: string) {
    await this.imageId(this.config.agentImage);
    const name = `bugfix-${run.id}-agent`; this.track(run, name);
    checked(await this.command(['run', '--detach', '--init', '--name', name, '--label', `bugfix.run=${run.id}`, '--network', this.config.dockerNetwork, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--pids-limit', '256',
      '--mount', `type=bind,source=${path.join(trustedDir, 'opencode.json')},target=/agent/opencode.json,readonly`, '--mount', `type=bind,source=${secretDir},target=/run/bugfix-secrets,readonly`,
      '--publish', '127.0.0.1::4096', '--env', `BUGFIX_RUN_ID=${run.id}`, '--env', `BUGFIX_CONTROLLER_URL=${this.config.controllerUrl}`, '--workdir', '/agent', this.config.agentImage]), 'Start OpenCode');
    run.agentContainer = name;
    const mapped = checked(await this.command(['port', name, '4096/tcp']), 'Find OpenCode Web port');
    const port = /:(\d+)/.exec(mapped)?.[1]; if (port) run.opencodeUrl = `http://localhost:${port}`;
    return { url: this.config.controllerUrl.startsWith('http://host.docker.internal:') ? run.opencodeUrl! : `http://${name}:4096`, password };
  }
}
