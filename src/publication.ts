import fs from 'node:fs/promises';
import type { Config, Manifest } from './types.ts';

export interface PublicationInspection {
  originalVerifiedCommit?: string; currentHead: string; changedSinceVerification?: boolean;
  reviewState: 'approved' | 'changes_requested' | 'pending' | 'unknown';
  ciState: 'success' | 'failure' | 'pending' | 'unknown';
  claState: 'success' | 'failure' | 'pending' | 'unknown';
  inspectedAt: string; inspectionErrors?: string[];
}
type State = PublicationInspection['ciState'];
const explicitCla = (name: unknown) => typeof name === 'string' && /(?:\bcla(?:[\s/_-]|$)|\bcla(?:assistant|bot)\b|contributor[\s_-]+licen[sc]e[\s_-]+agreement)/i.test(name);
function summarize(states: State[]): State {
  if (states.includes('failure')) return 'failure';
  if (states.includes('unknown') || !states.length) return 'unknown';
  if (states.includes('pending')) return 'pending';
  return 'success';
}
function checkState(check: any): State {
  if (check.status !== 'completed') return ['queued','in_progress','waiting','pending','requested'].includes(check.status) ? 'pending' : 'unknown';
  if (check.conclusion === 'success') return 'success';
  if (['failure','timed_out','cancelled','action_required','startup_failure','stale'].includes(check.conclusion)) return 'failure';
  return 'unknown';
}
const statusState = (status: any): State => status.state === 'success' ? 'success' : ['failure','error'].includes(status.state) ? 'failure' : status.state === 'pending' ? 'pending' : 'unknown';
/** Reads remote observations separately from immutable local verification. Never changes GitHub or the run. */
export async function inspectPublication(run: Manifest, config: Config, fetcher: typeof fetch = fetch): Promise<PublicationInspection> {
  const upstream = run.publicationIdentity?.upstream || run.profile?.upstream || config.profile.upstream;
  let url: URL; try { url = new URL(run.publication?.url || ''); } catch { throw new Error('A recorded publication URL is required'); }
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match || match[1].toLowerCase() !== upstream.toLowerCase()) throw new Error('Publication URL must belong to the recorded upstream repository');
  const token = (await fs.readFile(config.githubSecret, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw new Error('Cannot read the configured GitHub credential'); })).trim();
  if (/\s/.test(token)) throw new Error('The configured GitHub credential is invalid');
  const base = `https://api.github.com/repos/${match[1]}`;
  const request = async (endpoint: string) => {
    const response = await fetcher(base + endpoint, {method:'GET',headers:{accept:'application/vnd.github+json','x-github-api-version':'2026-03-10',...(token?{authorization:`Bearer ${token}`}:{})},signal:AbortSignal.timeout(30000),redirect:'error'});
    if (!response.ok) throw new Error(`GitHub inspection HTTP ${response.status}`);
    return {data:await response.json() as any,next:/rel="next"/.test(response.headers.get('link') || '')};
  };
  const list = async (endpoint: string, field?: string) => {
    const result: any[] = [];
    for (let page=1;page<=20;page++) {
      const response=await request(`${endpoint}${endpoint.includes('?')?'&':'?'}per_page=100&page=${page}`);
      const values=field?response.data?.[field]:response.data;
      if(!Array.isArray(values))throw new Error('GitHub inspection returned an incomplete list');
      result.push(...values);if(!response.next)return result;
    }
    throw new Error('GitHub inspection exceeds the complete pagination window');
  };
  const pr=(await request(`/pulls/${match[2]}`)).data;const currentHead=pr?.head?.sha;
  if(typeof currentHead !== 'string' || !/^[a-f0-9]{40,64}$/i.test(currentHead))throw new Error('GitHub inspection returned an invalid PR head');
  const originalVerifiedCommit=run.publication?.originalVerifiedCommit || run.verifiedCommit;
  const result: PublicationInspection = {originalVerifiedCommit,currentHead,...(originalVerifiedCommit?{changedSinceVerification:currentHead!==originalVerifiedCommit}:{}),reviewState:'unknown',ciState:'unknown',claState:'unknown',inspectedAt:new Date().toISOString()};
  const [reviews,checks,statuses]=await Promise.allSettled([list(`/pulls/${match[2]}/reviews`),list(`/commits/${currentHead}/check-runs?filter=latest`,'check_runs'),list(`/commits/${currentHead}/status`,'statuses')]);
  const errors: string[] = [];
  if(reviews.status==='fulfilled'){
    const decisions=new Map<string,string>();
    for(const review of reviews.value.slice().sort((a,b)=>String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')) || Number(a.id || 0)-Number(b.id || 0))){
      const reviewer=review.user?.login;if(!reviewer)continue;
      if(['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state))decisions.set(reviewer,review.state);
    }
    result.reviewState=[...decisions.values()].includes('CHANGES_REQUESTED')?'changes_requested':[...decisions.values()].includes('APPROVED')?'approved':'pending';
  }else errors.push('Reviews unavailable; review state is unknown');
  if(checks.status==='rejected')errors.push('Check runs unavailable; CI/CLA coverage is incomplete');
  if(statuses.status==='rejected')errors.push('Commit statuses unavailable; CI/CLA coverage is incomplete');
  const checkRuns=checks.status==='fulfilled'?checks.value:[],commitStatuses=statuses.status==='fulfilled'?statuses.value:[];
  // Skipped/neutral jobs are not evidence that CI passed; other successful jobs may still be.
  const ci=[...checkRuns.filter(check=>!(check.status==='completed' && ['neutral','skipped'].includes(check.conclusion))).map(check=>checkState(check)),...commitStatuses.map(statusState)];
  const cla=[...checkRuns.filter(check=>explicitCla(check.name)).map(check=>checkState(check)),...commitStatuses.filter(status=>explicitCla(status.context)).map(statusState)];
  if(checks.status==='rejected' || statuses.status==='rejected'){ci.push('unknown');cla.push('unknown');}
  result.ciState=summarize(ci);result.claState=summarize(cla);
  if(errors.length)result.inspectionErrors=errors;
  return result;
}
