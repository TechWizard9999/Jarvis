import { spawn } from 'node:child_process';
export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number; }
export async function exec(file: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void; maxBytes?: number;
} = {}): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env || process.env, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, killed = false;
    const max = options.maxBytes || 8 * 1024 * 1024;
    const kill = () => { if (killed) return; killed = true; try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM');
    } catch {} const hard = setTimeout(() => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 2000); hard.unref(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs || 60000);
    const abort = () => kill(); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout.on('data', (buf: Buffer) => { const s = buf.toString(); if (stdout.length < max) stdout += s.slice(0, max - stdout.length); options.onOutput?.(s, 'stdout'); });
    child.stderr.on('data', (buf: Buffer) => { const s = buf.toString(); if (stderr.length < max) stderr += s.slice(0, max - stderr.length); options.onOutput?.(s, 'stderr'); });
    child.on('error', e => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(e); });
    child.on('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve({ code: code ?? 128, stdout, stderr, timedOut, durationMs: Date.now() - start }); });
    child.stdin.on('error', () => {}); child.stdin.end(options.input);
  });
}
export function checked(result: ExecResult, context: string): string {
  if (result.code || result.timedOut) throw new Error(`${context}: ${result.timedOut ? 'timed out' : `exit ${result.code}`}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
