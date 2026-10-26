const $ = selector => document.querySelector(selector);
let selected, selectionId, selectionGeneration = 0, selectionAbort, stream, tab = 'activity', events = [], config, refreshTimer, renderGeneration = 0;
let logNode, lastRow, pending = [], frame, rowCount = 0, logFollow = true, logScrollTop = 0;
let lastSequence = 0, hasOlder = false, oldestSequence, unread = 0, withheld = false, historyGeneration = 0, historyAbort;
let activitySequence=0,lastActivityTime,currentCheck,retryUntil;
let filters = {search:'',stage:'',source:'',errors:false};
const MAX_ROWS = 1500;
const hasFilters = () => Object.values(filters).some(Boolean);
const samePart = (a, b) => a?.data?.partId && a.data.partId === b.data?.partId && a.data.messageId === b.data?.messageId && a.data.sessionId === b.data?.sessionId;
const mergeable = (a, b) => a && a.source === b.source && a.kind === b.kind && ((b.source === 'opencode' && ['message', 'provider_reasoning'].includes(b.kind) && samePart(a,b)) || (b.source === 'docker' && b.kind === 'output'));
const logAtEnd = () => logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight < 40;
function rememberLogPosition() { if (logNode?.isConnected) { logFollow = logAtEnd(); logScrollTop = logNode.scrollTop; } }
function observeActivity(event){
  if(event.seq<=activitySequence)return;activitySequence=event.seq;lastActivityTime=event.time;
  if(event.source==='check' && event.kind==='started')currentCheck=event.data?.id || event.message;
  if(event.source==='check' && event.kind==='finished')currentCheck=undefined;
  const retry=/retrying in (\d+)s/.exec(event.message || '');
  if(retry)retryUntil=Date.parse(event.time)+Number(retry[1])*1000;
  else if(['model_request','model_finished','started'].includes(event.kind))retryUntil=undefined;
  updateActivityMetrics();
}
function updateActivityMetrics(){
  const values={'last-activity':lastActivityTime?new Date(lastActivityTime).toLocaleTimeString([],{hour12:false}):'Unknown','current-check':currentCheck || 'None','retry-countdown':retryUntil?`${Math.max(0,Math.ceil((retryUntil-Date.now())/1000))}s`:'—'};
  for(const [id,value] of Object.entries(values)){const node=$(`#${id} strong`);if(node)node.textContent=value;}
}
function updateActivityControls() {
  const follow = $('#follow-live'); if (follow) follow.textContent = `Follow live${unread ? ` · ${unread} unread` : ''}`;
  const older = $('#load-older'); if (older) older.disabled = !hasOlder;
  const count = $('#history-count'); if (count) count.textContent = `${rowCount} displayed${withheld ? ' · newer events waiting' : ''}`;
}
function trimLog() { while (rowCount > MAX_ROWS && logNode.firstChild) { logNode.firstChild.remove(); rowCount--; } }
function resetLog(follow = true) {
  logNode = element('div', undefined, 'log'); lastRow = undefined; pending = []; rowCount = 0; logFollow = follow; logScrollTop = 0;
  if (frame) cancelAnimationFrame(frame); frame = undefined;
  logNode.addEventListener('scroll', () => {
    if (!logNode.isConnected) return;
    const wasFollowing = logFollow;
    logFollow = logAtEnd(); logScrollTop = logNode.scrollTop;
    if (logFollow && !wasFollowing) {
      unread = 0;
      if (withheld) void followLive().catch(e=>error(e.message));
      else {trimLog();logNode.scrollTop = logNode.scrollHeight;updateActivityControls();}
    }
  });
}
function artifactLink(runId, file, title) {
  const link = element('a', title, 'file-link'); link.href = `/api/runs/${runId}/artifact?path=${encodeURIComponent(file)}`; return link;
}
function eventRow(event) {
  const row = element('div',undefined,'logrow'); row.id = `event-${event.seq}`;row.dataset.seq=event.seq;
  const text = element('span',undefined,'message');text.append(document.createTextNode(event.message));
  const body = element('div',undefined,'event-body');body.append(text);
  if(event.data !== undefined){
    const details=element('details'),summary=element('summary','Event data');details.append(summary,element('pre',JSON.stringify(event.data,null,2)));body.append(details);
    const data=event.data || {};const log=data.log || data.result?.log;
    if(typeof log==='string')body.append(artifactLink(event.runId,log,'Check log'));
    for(const seq of data.evidenceIds || []){const link=element('a',`Evidence #${seq}`,'file-link');link.href=`#event-${seq}`;link.onclick=async e=>{e.preventDefault();await showEvidence(seq);};body.append(link);}
  }
  const identity=event.data?.role && event.data.role !== 'unknown' ? `${event.source} · ${event.data.role} · ${event.data.contentType}` : `${event.source} · ${event.kind}`;
  row.append(element('time',new Date(event.time).toLocaleTimeString([],{hour12:false})),element('span',identity,'source'),body);
  return {row,text,event};
}
function flushLog() {
  frame = undefined; if (!logNode) return;
  rememberLogPosition();
  for (const event of pending) {
    if (!logFollow && rowCount >= MAX_ROWS) {withheld = true;continue;}
    if (event.data?.operation === 'replace') {
      const matches = [...logNode.children].filter(row=>row.dataset.part === `${event.data.sessionId}:${event.data.messageId}:${event.data.partId}`);
      if(matches.length){matches[0].querySelector('.message').textContent=event.message;for(const row of matches.slice(1)){if(lastRow?.row===row)lastRow=undefined;row.remove();rowCount--;}continue;}
    }
    if (mergeable(lastRow?.event,event) && event.data?.operation !== 'replace') {lastRow.text.firstChild.appendData(event.message);lastRow.event=event;continue;}
    const built=eventRow(event);if(event.data?.partId)built.row.dataset.part=`${event.data.sessionId}:${event.data.messageId}:${event.data.partId}`;
    logNode.append(built.row);lastRow=built;rowCount++;
  }
  pending=[];
  if(logFollow){trimLog();if(logNode.isConnected)logNode.scrollTop=logNode.scrollHeight;}
  if(logNode.isConnected)logScrollTop=logNode.scrollTop;updateActivityControls();
}
function queueLog(event) {pending.push(event);if(!frame)frame=requestAnimationFrame(flushLog);}
function historyQuery(extra = {}) { const params=new URLSearchParams({limit:'500',...Object.fromEntries(Object.entries(filters).filter(([,v])=>v).map(([k,v])=>[k,String(v)])),...extra});return params; }
async function loadHistory({older=false, before, after} = {}) {
  const id=selectionId,generation=selectionGeneration,request=++historyGeneration;
  historyAbort?.abort();historyAbort=new AbortController();
  const params=historyQuery({...((before ?? (older ? oldestSequence : undefined))!==undefined?{before:String(before ?? oldestSequence)}:{}),...(after!==undefined?{after:String(after)}:{})});
  const page=await api(`/api/runs/${id}/history?${params}`,{signal:historyAbort.signal});
  if(generation!==selectionGeneration || id!==selectionId || request!==historyGeneration)return;
  const oldTop=logNode?.scrollTop || 0,oldHeight=logNode?.scrollHeight || 0;
  if(!older && !hasFilters())for(const event of page.events)observeActivity(event);
  events=older?[...page.events,...events].slice(0,MAX_ROWS):page.events;
  hasOlder=page.hasOlder;oldestSequence=events[0]?.seq;lastSequence=Math.max(lastSequence,page.latestSeq || events.at(-1)?.seq || 0);
  const follow=older?false:logFollow;
  resetLog(follow);for(const event of events)queueLog(event);flushLog();
  if(tab==='activity'){renderActivity();if(older){logNode.scrollTop=Math.max(0,logNode.scrollHeight-oldHeight+oldTop);logScrollTop=logNode.scrollTop;logFollow=false;}}
  updateActivityControls();
}
async function followLive(){unread=0;withheld=false;filters={search:'',stage:'',source:'',errors:false};logFollow=true;await loadHistory();if(selected)render();}
async function showEvidence(seq){filters={search:'',stage:'',source:'',errors:false};logFollow=false;await loadHistory({before:seq+1});if(tab!=='activity'){tab='activity';render();}document.getElementById(`event-${seq}`)?.scrollIntoView({block:'center'});}
const stages = ['preflight','environment','discovery','reproduction','patching','review','verification','publishing'];
const label = value => String(value || '').replaceAll('_',' ');
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
async function api(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw Error(data.error || response.statusText); return data; }
function error(message) { $('#error').hidden = !message; $('#error').textContent = message || ''; }
async function refresh() {
  const generation=selectionGeneration;const runs = await api('/api/runs'); const list = $('#runs'); list.replaceChildren();
  if (!runs.length) list.append(element('p','No runs yet.','muted'));
  for (const run of runs) {
    const button = element('button',undefined,'run' + (run.id === selectionId ? ' selected' : ''));
    button.append(element('strong',run.demo ? 'Simulated demo' : run.issue?.title || `Issue ${run.input.issue.split('/').at(-1)}`), element('small',new Date(run.createdAt).toLocaleString()), element('span',label(run.outcome || run.stage),'status'));
    button.onclick = () => choose(run.id).catch(e=>{if(e.name!=='AbortError')error(e.message);}); list.append(button);
  }
  if (selected && generation===selectionGeneration) { const latest = runs.find(r => r.id === selectionId); if (latest) { selected = latest; render(); } }
  if (generation===selectionGeneration) error('');
}
async function choose(id) {
  const generation=++selectionGeneration;selectionId=id;selected=undefined;$('#detail').replaceChildren(element('p','Loading run…','muted'));activitySequence=0;lastActivityTime=undefined;currentCheck=undefined;retryUntil=undefined;selectionAbort?.abort();selectionAbort=new AbortController();historyAbort?.abort();
  stream?.close();stream=undefined;clearTimeout(refreshTimer);events=[];lastSequence=0;unread=0;withheld=false;hasOlder=false;filters={search:'',stage:'',source:'',errors:false};resetLog();
  const run=await api(`/api/runs/${id}`,{signal:selectionAbort.signal});
  if(generation!==selectionGeneration || id!==selectionId)return;
  selected=run;render();await loadHistory();
  if(generation!==selectionGeneration || id!==selectionId)return;
  const connection=new EventSource(`/api/runs/${id}/events?after=${lastSequence}`);stream=connection;
  const current=()=>generation===selectionGeneration&&selectionId===id&&stream===connection;
  connection.onopen=()=>{if(current())$('#connection').textContent='Live connection';};
  connection.onerror=()=>{if(current())$('#connection').textContent='Reconnecting';};
  connection.onmessage=event=>{
    if(!current())return;let item;try{item=JSON.parse(event.data);}catch{return;}
    if(item.runId!==id || item.seq<=lastSequence)return;lastSequence=item.seq;observeActivity(item);
    rememberLogPosition();if(!logFollow)unread++;
    if(!hasFilters()){
      if(!logFollow&&events.length>=MAX_ROWS){withheld=true;}else{events.push(item);if(events.length>MAX_ROWS)events=events.slice(-MAX_ROWS);queueLog(item);}
    }else{withheld=true;}
    updateActivityControls();
    if(['stage','outcome','finished'].includes(item.kind)){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(current())refresh().catch(e=>error(e.message));},150);}
  };
  void refresh().catch(e=>error(e.message));
}
function render() {
  if (!selected) return;
  rememberLogPosition();
  const view=++renderGeneration, generation=selectionGeneration;
  const run = selected, detail = $('#detail'); detail.replaceChildren();
  const head = element('div',undefined,'detail-head'), title = element('div');
  title.append(element('h2',run.demo ? 'Interface demonstration' : run.issue?.title || 'Preparing repair'),element('p',run.id)); head.append(title);
  const actions = element('div',undefined,'actions');
  if (!run.outcome && !run.demo) { const cancel = element('button','Cancel'); cancel.onclick = async () => { try { await api(`/api/runs/${run.id}/cancel`,{method:'POST'}); await refresh(); } catch(e) { error(e.message); } }; actions.append(cancel); }
  if (['verified_unpublished', 'verified_patch'].includes(run.outcome) && run.verifiedCommit && run.input.mode !== 'evaluation') { const publish = element('button','Publish verified draft'); publish.onclick = async () => { publish.disabled = true; try { await api(`/api/runs/${run.id}/publish`,{method:'POST'}); await refresh(); } catch(e) { error(e.message); publish.disabled = false; } }; actions.append(publish); }
  head.append(actions); detail.append(head);
  if (run.demo) detail.append(element('div','SIMULATED DEMO — no real model, repair, verification or PR.','banner warning'));
  if (run.error && !run.demo) detail.append(element('div',run.error,'banner warning'));
  if (run.publication?.error) detail.append(element('div',`Draft PR not created: ${run.publication.error}`,'banner warning'));
  if(run.publication?.changedSinceVerification || run.publication?.currentHead && run.publication.currentHead!==run.verifiedCommit)detail.append(element('div','PR changed since verification. Later changes require separate evidence.','banner warning'));
  if (run.publication?.url) { const banner = element('div',undefined,'banner'); banner.append(element('span','Draft PR created · ')); const link = element('a',run.publication.url); link.href = run.publication.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; banner.append(link); detail.append(banner); }
  const steps = element('div',undefined,'steps'), current = stages.indexOf(run.failureStage || run.stage);
  for (let i = 0; i < stages.length; i++) steps.append(element('div',label(stages[i]),'step ' + (i === current ? 'current' : i < current || run.stage === 'complete' && i <= (run.outcome === 'draft_created' ? stages.indexOf('publishing') : ['verified_patch','demo_complete','verified_unpublished'].includes(run.outcome) ? stages.indexOf('verification') : -1) ? 'done' : '')));
  detail.append(steps);
  const metrics = element('div',undefined,'metrics');
  const finished=run.executionFinishedAt || (run.outcome ? run.updatedAt : new Date().toISOString());
  const elapsed = Math.max(0,Math.round((Date.parse(finished)-Date.parse(run.executionStartedAt || run.createdAt))/1000));
  const usage=run.demo?'0 (demo)':run.modelRequests?.length?`${run.tokens.toLocaleString()}${run.modelRequests.some(r=>r.usage!=='complete')?' · partial/unknown':''}`:run.tokens?`${run.tokens.toLocaleString()} · legacy total`:'Unknown';
  for (const [name,value] of [['Status',label(run.outcome || run.stage)],['Elapsed',`${Math.floor(elapsed/60)}m ${elapsed%60}s`],['Attempt',run.attempt || '—'],['Tool calls',run.tools],['Reported tokens',usage],['Last activity','Unknown'],['Current check','None'],['Retry countdown','—']]) { const metric = element('div',undefined,'metric');if(['Last activity','Current check','Retry countdown'].includes(name))metric.id={'Last activity':'last-activity','Current check':'current-check','Retry countdown':'retry-countdown'}[name]; metric.append(element('span',name),element('strong',value)); metrics.append(metric); } detail.append(metrics);updateActivityMetrics();
  const tabs = element('div',undefined,'tabs');
  for (const name of ['activity','diff','checks','usage','report']) { const button = element('button',name[0].toUpperCase()+name.slice(1),tab===name?'active':''); button.onclick=()=>{tab=name;render();}; tabs.append(button); } detail.append(tabs,element('div',undefined,'tab-content'));
  if (tab==='activity') renderActivity();
  if (tab==='diff') api(`/api/runs/${run.id}/diff`).then(data=>{if(generation===selectionGeneration && view===renderGeneration && selected?.id===run.id && tab==='diff') $('.tab-content').append(element('pre',data.diff || 'No source diff yet.'));}).catch(e=>{if(generation===selectionGeneration&&view===renderGeneration)error(e.message);});
  if (tab==='checks') { for (const check of run.checks) { const row=element('div',undefined,'logrow'); row.append(element('time',`${Math.round(check.durationMs/1000)}s`),element('span',check.status==='no_match' || check.matched===0?'NO MATCH':check.timedOut?'TIMEOUT':check.exitCode===0?'PASS':'FAIL','source'),element('span',`${check.id}\n${check.argv.join(' ')}`,'message')); row.append(artifactLink(run.id,check.log,'Check log'));$('.tab-content').append(row); } }
  if(tab==='usage'){const content=$('.tab-content');for(const request of run.modelRequests || []){const row=element('div',undefined,'logrow');row.append(element('time',request.latencyMs===undefined?'pending':`${(request.latencyMs/1000).toFixed(1)}s`),element('span',request.usage,'source'),element('span',`${request.id} · ${request.status} · ${request.attempts} attempts\nInput ${request.inputTokens ?? 'unknown'} · output ${request.outputTokens ?? 'unknown'} · total ${request.totalTokens ?? 'unknown'}`,'message'));content.append(row);}if(!run.modelRequests?.length)content.append(element('p','Per-request usage is unavailable for this run.','muted'));}
  if (tab==='report') { const link=element('a','Download report','file-link');link.href=`/api/runs/${run.id}/artifact?path=report.md`;$('.tab-content').append(link); const patch=element('a','Download patch','file-link');patch.href=`/api/runs/${run.id}/artifact?path=candidate.patch`;$('.tab-content').append(patch);if(run.runConfig)$('.tab-content').append(artifactLink(run.id,run.runConfig.artifact,'Run configuration'));if(run.acceptancePlan)$('.tab-content').append(artifactLink(run.id,'acceptance-plan.json','Acceptance plan')); fetch(`/api/runs/${run.id}/artifact?path=report.md`).then(async response=>{const text=await response.text();if(response.ok && generation===selectionGeneration && view===renderGeneration && selected?.id===run.id && tab==='report')$('.tab-content').append(element('pre',text));}).catch(e=>{if(generation===selectionGeneration&&view===renderGeneration)error(e.message);}); }
}
function renderActivity() {
  const content=$('.tab-content');if(!content || tab!=='activity' || !logNode)return;
  const toolbar=element('div',undefined,'activity-tools');
  const older=element('button','Load older');older.id='load-older';older.disabled=!hasOlder;older.onclick=()=>loadHistory({older:true}).catch(e=>{if(e.name!=='AbortError')error(e.message);});
  const follow=element('button','Follow live');follow.id='follow-live';follow.onclick=()=>followLive().catch(e=>error(e.message));
  const search=element('input');search.type='search';search.placeholder='Search activity';search.setAttribute('aria-label','Search activity');search.value=filters.search;
  let searchTimer;search.oninput=()=>{filters.search=search.value;logFollow=false;clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadHistory().catch(e=>{if(e.name!=='AbortError')error(e.message);}),180);};
  const select=(key,title,values)=>{const node=element('select');node.setAttribute('aria-label',title);for(const value of ['',...values]){const option=element('option',value || title);option.value=value;node.append(option);}node.value=filters[key];node.onchange=()=>{filters[key]=node.value;logFollow=false;void loadHistory().catch(e=>{if(e.name!=='AbortError')error(e.message);});};return node;};
  const errors=element('label',undefined,'inline');const box=element('input');box.type='checkbox';box.checked=filters.errors;box.onchange=()=>{filters.errors=box.checked;logFollow=false;void loadHistory().catch(e=>{if(e.name!=='AbortError')error(e.message);});};errors.append(box,document.createTextNode('Errors only'));
  toolbar.append(older,follow,search,select('stage','All stages',stages),select('source','All sources',['controller','check','tool','verifier','publisher','opencode','gateway','docker','graphify','git','github']),errors,element('span',undefined,'muted'));toolbar.lastChild.id='history-count';
  content.replaceChildren(toolbar,logNode);logNode.scrollTop=logFollow?logNode.scrollHeight:logScrollTop;updateActivityControls();
}
$('#run-form').onsubmit=async event=>{event.preventDefault();error('');$('#start').disabled=true;try{const run=await api('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:$('#repo').value,issue:$('#issue').value,publish:$('#publish').checked,retrieval:'graph'})});await choose(run.id);}catch(e){error(e.message);}finally{$('#start').disabled=false;}};
$('#demo').onclick=async()=>{try{const run=await api('/api/demo',{method:'POST'});await choose(run.id);}catch(e){error(e.message);}};
$('#refresh').onclick=()=>refresh().catch(e=>error(e.message));
$('#doctor').onclick=async()=>{try{$('#setup').hidden=false;$('#setup-results').textContent='Checking…';const checks=await api('/api/doctor');$('#setup-results').replaceChildren();for(const check of checks){const row=element('div',undefined,'setup-row'+(!check.ok?' bad':''));row.append(element('b',check.ok?'PASS':check.required?'FAIL':'NOTE'),element('span',`${check.name}: ${check.detail}`));$('#setup-results').append(row);}}catch(e){error(e.message);}};
(async()=>{try{config=await api('/api/status');$('#repo').placeholder=`${config.repoRoot}/${config.profile.upstream.split('/')[1]}`;$('#issue').placeholder=`https://github.com/${config.profile.upstream}/issues/…`;$('#connection').textContent='Connected';await refresh();const params=new URLSearchParams(location.search);if(params.get('run')){await choose(params.get('run'));const seq=Number(params.get('event'));if(Number.isSafeInteger(seq)&&seq>0)await showEvidence(seq);}}catch(e){error(e.message);$('#connection').textContent='Disconnected';}})();
setInterval(()=>{if(selected && !selected.outcome)refresh().catch(()=>{});},5000);

setInterval(updateActivityMetrics,1000);
