const $ = selector => document.querySelector(selector);
let selected, stream, tab = 'activity', events = [], config, refreshTimer;
// The activity log is built incrementally and kept across re-renders: rebuilding it per event froze the page on
// runs with thousands of events. Streamed model fragments and consecutive command output merge into one row.
let logNode, lastRow, pending = [], frame, rowCount = 0;
const MAX_ROWS = 1500;
const mergeable = (a, b) => a && a.source === b.source && a.kind === b.kind && ((b.source === 'opencode' && ['message', 'provider_reasoning'].includes(b.kind)) || (b.source === 'docker' && b.kind === 'output'));
function resetLog() { logNode = element('div', undefined, 'log'); lastRow = undefined; pending = []; rowCount = 0; if (frame) cancelAnimationFrame(frame); frame = undefined; }
function flushLog() {
  frame = undefined; if (!logNode) return;
  const atBottom = logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight < 40;
  for (const event of pending) {
    // Fragments already carry their own line breaks; appendData avoids re-parsing the whole row each time.
    if (mergeable(lastRow?.event, event)) { lastRow.text.firstChild.appendData(event.message); lastRow.event = event; continue; }
    const row = element('div', undefined, 'logrow'), text = element('span', undefined, 'message'); text.append(document.createTextNode(event.message));
    row.append(element('time', new Date(event.time).toLocaleTimeString([], { hour12: false })), element('span', event.source, 'source'), text);
    logNode.append(row); lastRow = { event, text }; rowCount++;
  }
  pending = [];
  while (rowCount > MAX_ROWS && logNode.firstChild) { logNode.firstChild.remove(); rowCount--; }
  if (atBottom) logNode.scrollTop = logNode.scrollHeight;
}
function queueLog(event) { pending.push(event); if (!frame) frame = requestAnimationFrame(flushLog); }
const stages = ['preflight','environment','discovery','reproduction','patching','review','verification','publishing'];
const label = value => String(value || '').replaceAll('_',' ');
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
async function api(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw Error(data.error || response.statusText); return data; }
function error(message) { $('#error').hidden = !message; $('#error').textContent = message || ''; }
async function refresh() {
  const runs = await api('/api/runs'); const list = $('#runs'); list.replaceChildren();
  if (!runs.length) list.append(element('p','No runs yet.','muted'));
  for (const run of runs) {
    const button = element('button',undefined,'run' + (run.id === selected?.id ? ' selected' : ''));
    button.append(element('strong',run.demo ? 'Simulated demo' : run.issue?.title || `Issue ${run.input.issue.split('/').at(-1)}`), element('small',new Date(run.createdAt).toLocaleString()), element('span',label(run.outcome || run.stage),'status'));
    button.onclick = () => choose(run.id); list.append(button);
  }
  if (selected) { const latest = runs.find(r => r.id === selected.id); if (latest) { selected = latest; render(); } }
  error('');
}
async function choose(id) {
  stream?.close(); events = []; resetLog(); selected = await api(`/api/runs/${id}`); render(); await refresh();
  stream = new EventSource(`/api/runs/${id}/events`);
  stream.onopen = () => { $('#connection').textContent = 'Live connection'; };
  stream.onerror = () => { $('#connection').textContent = 'Reconnecting'; };
  stream.onmessage = event => {
    const item = JSON.parse(event.data); if (item.seq <= (events.at(-1)?.seq ?? 0)) return; events.push(item);
    if (events.length > 4000) events = events.slice(-4000);
    queueLog(item);
    if (item.kind === 'stage' || item.kind === 'outcome' || item.kind === 'finished') { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(e => error(e.message)), 150); }
  };
}
function render() {
  if (!selected) return;
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
  if (run.publication?.url) { const banner = element('div',undefined,'banner'); banner.append(element('span','Draft PR created · ')); const link = element('a',run.publication.url); link.href = run.publication.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; banner.append(link); detail.append(banner); }
  const steps = element('div',undefined,'steps'), current = stages.indexOf(run.stage);
  for (let i = 0; i < stages.length; i++) steps.append(element('div',label(stages[i]),'step ' + (i === current ? 'current' : i < current || run.stage === 'complete' && i <= (run.outcome === 'draft_created' ? stages.indexOf('publishing') : ['verified_patch','demo_complete','verified_unpublished'].includes(run.outcome) ? stages.indexOf('verification') : -1) ? 'done' : '')));
  detail.append(steps);
  const metrics = element('div',undefined,'metrics');
  const elapsed = Math.max(0, Math.round((Date.parse(run.outcome ? run.updatedAt : new Date().toISOString()) - Date.parse(run.createdAt))/1000));
  for (const [name,value] of [['Status',label(run.outcome || run.stage)],['Elapsed',`${Math.floor(elapsed/60)}m ${elapsed%60}s`],['Attempt',run.attempt || '—'],['Tool calls',run.tools],['Reported tokens',run.tokens]]) { const metric = element('div',undefined,'metric'); metric.append(element('span',name),element('strong',value)); metrics.append(metric); } detail.append(metrics);
  const tabs = element('div',undefined,'tabs');
  for (const name of ['activity','diff','checks','report']) { const button = element('button',name[0].toUpperCase()+name.slice(1),tab===name?'active':''); button.onclick=()=>{tab=name;render();}; tabs.append(button); } detail.append(tabs,element('div',undefined,'tab-content'));
  if (tab==='activity') renderActivity();
  if (tab==='diff') api(`/api/runs/${run.id}/diff`).then(data=>{if(selected?.id===run.id && tab==='diff') $('.tab-content').append(element('pre',data.diff || 'No source diff yet.'));}).catch(e=>error(e.message));
  if (tab==='checks') { for (const check of run.checks) { const row=element('div',undefined,'logrow'); row.append(element('time',`${Math.round(check.durationMs/1000)}s`),element('span',check.exitCode===0?'PASS':'FAIL','source'),element('span',`${check.id}\n${check.argv.join(' ')}`,'message')); $('.tab-content').append(row); } }
  if (tab==='report') { const link=element('a','Download report','file-link');link.href=`/api/runs/${run.id}/artifact?path=report.md`;$('.tab-content').append(link); const patch=element('a','Download patch','file-link');patch.href=`/api/runs/${run.id}/artifact?path=candidate.patch`;$('.tab-content').append(patch); fetch(`/api/runs/${run.id}/artifact?path=report.md`).then(async response=>{if(response.ok && selected?.id===run.id && tab==='report')$('.tab-content').append(element('pre',await response.text()));}); }
}
function renderActivity() {
  const content = $('.tab-content'); if (!content || tab !== 'activity' || !logNode) return;
  const top = logNode.scrollTop; content.replaceChildren(logNode); logNode.scrollTop = top;
}
$('#run-form').onsubmit=async event=>{event.preventDefault();error('');$('#start').disabled=true;try{const run=await api('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:$('#repo').value,issue:$('#issue').value,publish:$('#publish').checked,retrieval:'graph'})});await choose(run.id);}catch(e){error(e.message);}finally{$('#start').disabled=false;}};
$('#demo').onclick=async()=>{try{const run=await api('/api/demo',{method:'POST'});await choose(run.id);}catch(e){error(e.message);}};
$('#refresh').onclick=()=>refresh().catch(e=>error(e.message));
$('#doctor').onclick=async()=>{try{$('#setup').hidden=false;$('#setup-results').textContent='Checking…';const checks=await api('/api/doctor');$('#setup-results').replaceChildren();for(const check of checks){const row=element('div',undefined,'setup-row'+(!check.ok?' bad':''));row.append(element('b',check.ok?'PASS':check.required?'FAIL':'NOTE'),element('span',`${check.name}: ${check.detail}`));$('#setup-results').append(row);}}catch(e){error(e.message);}};
(async()=>{try{config=await api('/api/status');$('#repo').placeholder=`${config.repoRoot}/${config.profile.upstream.split('/')[1]}`;$('#issue').placeholder=`https://github.com/${config.profile.upstream}/issues/…`;$('#connection').textContent='Connected';await refresh();}catch(e){error(e.message);$('#connection').textContent='Disconnected';}})();
setInterval(()=>{if(selected && !selected.outcome)refresh().catch(()=>{});},5000);
