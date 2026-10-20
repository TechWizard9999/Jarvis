import fs from 'node:fs/promises';
import type { Config, Issue, Manifest } from './types.ts';

export type GitHubIssueErrorKind = 'authentication' | 'permission' | 'rate_limit' | 'transient' | 'not_found' | 'invalid_issue';
export class GitHubIssueError extends Error {
  kind: GitHubIssueErrorKind;
  status?: number;
  retryAt?: number;
  retryable: boolean;
  constructor(kind: GitHubIssueErrorKind, message: string, options: { status?: number; retryAt?: number } = {}) {
    super(message); this.name = 'GitHubIssueError'; this.kind = kind; this.status = options.status; this.retryAt = options.retryAt;
    this.retryable = kind === 'rate_limit' || kind === 'transient';
  }
}

function retryTime(headers: Headers): number | undefined {
  const times: number[] = [];
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) times.push(reset * 1000);
  const after = headers.get('retry-after');
  if (after !== null) {
    const seconds = Number(after), date = Date.parse(after);
    if (Number.isFinite(seconds) && seconds >= 0) times.push(Date.now() + seconds * 1000);
    else if (Number.isFinite(date)) times.push(date);
  }
  return times.length ? Math.max(...times) : undefined;
}

/** One request; the controller decides when to retry from the typed failure and provider retry time. */
export async function fetchGitHubIssue(run: Manifest, config: Config, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Issue> {
  signal?.throwIfAborted();
  const number = Number(new URL(run.input.issue).pathname.split('/').filter(Boolean).at(-1));
  if (!Number.isSafeInteger(number) || number < 1) throw new GitHubIssueError('invalid_issue', 'Provide a valid GitHub issue number');
  let secret: string;
  try { secret = await fs.readFile(config.githubSecret, { encoding: 'utf8', signal }); }
  catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') secret = '';
    else throw new GitHubIssueError('authentication', 'GitHub credential file could not be read; check its availability and permissions');
  }
  signal?.throwIfAborted();
  const token = secret.trim();
  if (token && /\s/.test(token)) throw new GitHubIssueError('authentication', 'GitHub credential file is invalid; replace it with one token');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  let response: Response, payload: unknown;
  try {
    response = await fetcher(`https://api.github.com/repos/${(run.profile || config.profile).upstream}/issues/${number}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'bugfix-agent/0.1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: requestSignal,
    });
    signal?.throwIfAborted();
    // Consume failed responses too so primary/secondary rate limits can be distinguished from permissions.
    const body = await response.text(); signal?.throwIfAborted();
    try { payload = body ? JSON.parse(body) : {}; }
    catch { payload = {}; if (response.ok) throw new GitHubIssueError('transient', 'GitHub issue response was not valid JSON'); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitHubIssueError) throw error;
    throw new GitHubIssueError('transient', requestSignal.aborted ? 'GitHub issue fetch timed out; retry when the connection is available' : 'GitHub issue fetch failed due to a transport error');
  }
  if (!response.ok) {
    const status = response.status;
    const message = payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : '';
    const limited = status === 429 || status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|secondary rate/i.test(message));
    if (limited) throw new GitHubIssueError('rate_limit', `GitHub issue fetch: HTTP ${status}; API rate limit reached`, { status, retryAt: retryTime(response.headers) ?? Date.now() + 60000 });
    if (status === 401) throw new GitHubIssueError('authentication', 'GitHub issue fetch: HTTP 401; configured credentials are invalid or expired', { status });
    if (status === 403) throw new GitHubIssueError('permission', 'GitHub issue fetch: HTTP 403; credentials lack permission for this repository', { status });
    if (status === 404 || status === 410) throw new GitHubIssueError('not_found', `GitHub issue fetch: HTTP ${status}; issue was not found or is inaccessible`, { status });
    if (status === 408 || status >= 500) throw new GitHubIssueError('transient', `GitHub issue fetch: HTTP ${status}; service is temporarily unavailable`, { status });
    throw new GitHubIssueError('invalid_issue', `GitHub issue fetch: HTTP ${status}; request cannot be retried without correcting the input`, { status });
  }
  signal?.throwIfAborted();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GitHubIssueError('transient', 'GitHub issue response had an invalid shape');
  const issue = payload as Record<string, unknown>;
  if (issue.pull_request) throw new GitHubIssueError('invalid_issue', 'Input must be an issue, not a pull request');
  if (run.input.mode !== 'evaluation' && issue.state === 'closed') throw new GitHubIssueError('invalid_issue', 'Live repairs require an open issue; use evaluation mode for historical cases');
  return { number, url: run.input.issue, title: String(issue.title || ''), body: String(issue.body || '').slice(0, 40000) };
}
