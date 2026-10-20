import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const output = '/artifacts/publication-result.json';
let input;
function command(file,args) {
  const result=spawnSync(file,args,{encoding:'utf8',env:process.env,timeout:180000,maxBuffer:8*1024*1024});
  if(result.error || result.status!==0) throw Error(`${file} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const git=args=>command('git',['-c','core.hooksPath=/empty-hooks','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args]);
async function save(value){await fs.writeFile(output+'.tmp',JSON.stringify(value,null,2)+'\n');await fs.rename(output+'.tmp',output);}
try {
  input=JSON.parse(await fs.readFile('/artifacts/publication-input.json','utf8'));
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if(!repo.test(input.fork) || !repo.test(input.upstream) || !/^fix\/issue-[0-9]+-[a-z0-9-]+$/.test(input.branch) || !/^[a-f0-9]{40,64}$/.test(input.commit) || !/^[a-f0-9]{40,64}$/.test(input.tree) || !/^[A-Za-z0-9_./-]+$/.test(input.base) || input.base.includes('..') || input.base.startsWith('-') || !Number.isSafeInteger(input.issue) || input.issue<1)throw Error('Invalid publication identity');
  process.env.GH_TOKEN=(await fs.readFile('/run/secrets/github_token','utf8')).trim();
  process.env.GH_PROMPT_DISABLED='1';process.env.GIT_TERMINAL_PROMPT='0';process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL='/dev/null';
  command('gh',['api','user']);
  const owner=input.fork.split('/')[0];
  const find=()=>JSON.parse(command('gh',['api',`repos/${input.upstream}/pulls?state=all&base=${encodeURIComponent(input.base)}&head=${encodeURIComponent(owner+':'+input.branch)}&per_page=100`]));
  const existing=find().filter(pr=>pr.head?.repo?.full_name?.toLowerCase()===input.fork.toLowerCase() && pr.head.ref===input.branch);
  if(existing.length>1)throw Error('Multiple matching PR identities; human review required');
  if(existing.length){
    // Our PR for this exact verified commit already exists (e.g. an uncertain earlier attempt): reuse it in any draft state.
    const pr=existing[0];
    if(pr.head.sha!==input.commit || pr.base.ref!==input.base)throw Error('A PR for this branch exists with a different head/base; refusing to overwrite it');
    if(pr.state==='open'){await save({url:pr.html_url,commit:pr.head.sha,draft:!!pr.draft,reused:true});process.exit(0);}
  }
  // Other open PRs linked to the issue are disclosed in the draft's description, not treated as a blocker.
  // (`--jq` per page instead of `--slurp`, which Debian's gh 2.23 lacks.)
  const timeline=command('gh',['api','--paginate',`repos/${input.upstream}/issues/${input.issue}/timeline?per_page=100`,'--jq','.[] | select(.event=="cross-referenced" and .source.issue.pull_request != null and .source.issue.state=="open") | [.source.issue.html_url, .source.issue.user.login] | @tsv']);
  const linked=timeline.split('\n').filter(Boolean).map(line=>line.split('\t')).filter(([,login])=>login?.toLowerCase()!==owner.toLowerCase()).map(([url])=>url);
  let body=await fs.readFile('/artifacts/report-pr.md','utf8');
  if(linked.length)body+=`\n\nOther open PRs reference this issue: ${[...new Set(linked)].join(', ')}. This draft is an independently generated and verified alternative for maintainers to compare.\n`;
  await fs.writeFile('/publish/body.md',body);
  git(['init','.']);git(['fetch','/artifacts/verified.bundle',`refs/heads/${input.branch}`]);
  git(['checkout','--detach','FETCH_HEAD']);
  if(git(['rev-parse','HEAD'])!==input.commit || git(['rev-parse','HEAD^{tree}'])!==input.tree)throw Error('Bundle does not match the independently verified tree/commit');
  const remote=`https://github.com/${input.fork}.git`;
  const remoteHead=git(['ls-remote','--heads',remote,`refs/heads/${input.branch}`]);
  if(remoteHead && remoteHead.split(/\s+/)[0]!==input.commit)throw Error('Remote branch has different content; refusing to overwrite it');
  git(['push',remote,`HEAD:refs/heads/${input.branch}`]);
  const head=input.fork.toLowerCase()===input.upstream.toLowerCase()?input.branch:`${owner}:${input.branch}`;
  const url=command('gh',['pr','create','--draft','--repo',input.upstream,'--base',input.base,'--head',head,'--title',typeof input.title==='string' && input.title.length<=120 && !/[\r\n\x00-\x1f]/.test(input.title) ? input.title : `fix: resolve issue #${input.issue}`,'--body-file','/publish/body.md']);
  const pr=JSON.parse(command('gh',['api',`repos/${input.upstream}/pulls/${url.split('/').at(-1)}`]));
  if(pr.head.sha!==input.commit || !pr.draft || pr.base.ref!==input.base || pr.head.repo.full_name.toLowerCase()!==input.fork.toLowerCase())throw Error('Created PR metadata differs from the verified publication identity');
  await save({url:pr.html_url,commit:pr.head.sha,draft:true});console.log(pr.html_url);
}catch(error){
  const message=String(error.message || error).replace(/(?:gh[pousr]_|github_pat_|nvapi-)[A-Za-z0-9_-]+/g,'[REDACTED]');
  await save({error:message,commit:input?.commit});console.error(message);process.exitCode=1;
}
