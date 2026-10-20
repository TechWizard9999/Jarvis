import fs from 'node:fs/promises';
import type { Config, Manifest } from './types.ts';
export async function competingPullRequests(upstream: string, issue: number, read: (url:string)=>Promise<{values:any[];next?:string}>) {
  const found = new Set<string>(); let next: string | undefined = `https://api.github.com/repos/${upstream}/issues/${issue}/timeline?per_page=100`;
  while(next) {
    const page = await read(next);
    for(const event of page.values) {
      const referenced=event.event === 'cross-referenced' && event.source?.issue;
      if(referenced?.state === 'open' && referenced.pull_request && typeof referenced.html_url === 'string') found.add(referenced.html_url);
    }
    next=page.next;
  }
  return [...found];
}
export async function fetchCompetingPullRequests(run: Manifest, config: Config, signal?: AbortSignal) {
  signal?.throwIfAborted(); const token=(await fs.readFile(config.githubSecret,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})).trim();
  return competingPullRequests((run.profile || config.profile).upstream, run.issue!.number, async url => {
    signal?.throwIfAborted(); if(!url.startsWith('https://api.github.com/'))throw new Error('Invalid GitHub pagination URL');
    const response=await fetch(url,{headers:{accept:'application/vnd.github+json','user-agent':'bugfix-agent/0.1',...(token?{authorization:`Bearer ${token}`}:{})},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Competing PR preflight: GitHub HTTP ${response.status}`);
    const values=await response.json(); if(!Array.isArray(values))throw new Error('Invalid GitHub issue timeline');
    return {values,next: /<([^>]+)>; rel="next"/.exec(response.headers.get('link') || '')?.[1]};
  });
}
