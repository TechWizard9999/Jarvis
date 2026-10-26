/** Local monitoring regression: delayed run selection and bounded navigable history. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const {chromium}=await import(process.env.BUGFIX_PLAYWRIGHT_MODULE || 'playwright');
const now=new Date().toISOString();
const run=id=>({id,input:{issue:'https://github.com/rtk-ai/rtk/issues/1',mode:'live'},issue:{title:`Run ${id}`},createdAt:now,updatedAt:now,stage:'verification',attempt:1,tools:1,tokens:0,checks:[{id:'final-focused',argv:['cargo','test'],exitCode:0,durationMs:100,log:'verification/focused.log'}],graphReady:false,graphStale:false});
const runs=[run('aaaaaaaa'),run('bbbbbbbb')]; const subscribers=new Set(); let releaseA; let connectionCount=0;
const event=seq=>({seq,runId:'bbbbbbbb',time:now,stage:seq%2?'discovery':'verification',source:seq%3?'controller':'opencode',kind:seq===99990?'tool_rejected':'output',message:seq===99990?'patch rejected stale revision':`event ${seq}`,data:seq===99990?{evidenceIds:[42],log:'verification/focused.log',reason:'content hash changed'}:undefined});
const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/status')return json(res,{repoRoot:'/tmp',profile:{upstream:'rtk-ai/rtk'}});
 if(url.pathname==='/api/runs')return json(res,runs);
 if(url.pathname==='/api/runs/aaaaaaaa'){releaseA=()=>json(res,runs[0]);return;}
 if(url.pathname==='/api/runs/bbbbbbbb')return json(res,runs[1]);
 if(url.pathname==='/api/runs/bbbbbbbb/history'){
  const limit=Number(url.searchParams.get('limit')||500),before=Number(url.searchParams.get('before')||100001),search=url.searchParams.get('search'),stage=url.searchParams.get('stage'),errors=url.searchParams.get('errors');
  const values=[];for(let seq=Math.min(before-1,100000);seq>=1&&values.length<limit;seq--){const item=event(seq);if(search&&!JSON.stringify(item).includes(search)||stage&&item.stage!==stage||errors&&item.kind!=='tool_rejected')continue;values.unshift(item);}
  return json(res,{events:values,hasOlder:(values[0]?.seq||1)>1,before:values[0]?.seq,latestSeq:100000});
 }
 if(url.pathname.endsWith('/events')){connectionCount++;res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();subscribers.add(res);req.on('close',()=>subscribers.delete(res));return;}
 if(url.pathname.endsWith('/diff'))return json(res,{diff:''});
 if(url.pathname.endsWith('/artifact')){res.writeHead(200,{'content-type':'text/plain'});return res.end('evidence');}
 const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const name=assets[url.pathname];if(!name){res.writeHead(404);return res.end();}res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(await fs.readFile(path.join(process.cwd(),'public',name)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.BUGFIX_BROWSER_CHANNEL||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.getByRole('button',{name:/Run aaaaaaaa/}).click();
 await page.getByRole('button',{name:/Run bbbbbbbb/}).click();
 await page.getByRole('heading',{name:'Run bbbbbbbb'}).waitFor();
 releaseA();await page.waitForTimeout(150);
 assert.equal(await page.locator('#detail h2').textContent(),'Run bbbbbbbb','delayed A cannot replace B');
 assert.equal(connectionCount,1,'selection creates one stream');assert.equal(subscribers.size,1);
 await page.waitForFunction(()=>document.querySelectorAll('.logrow').length>0);
 assert.ok(await page.locator('.logrow').count()<=1500);await page.getByText('event 100000',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Load older'}).click();await page.getByText('event 99001',{exact:true}).waitFor();
 await page.getByRole('searchbox',{name:'Search activity'}).fill('stale revision');
 await page.waitForFunction(()=>document.querySelectorAll('.logrow').length===1);
 await page.getByText('patch rejected stale revision',{exact:true}).waitFor();
 await page.getByText('Event data',{exact:true}).click();await page.getByText(/content hash changed/).waitFor();
 assert.ok(await page.getByRole('link',{name:'Check log'}).count()>0);
 await page.getByRole('searchbox',{name:'Search activity'}).fill('');
 await page.waitForFunction(()=>document.querySelectorAll('.logrow').length>10);
 await page.getByRole('button',{name:/Follow live/}).click();await page.waitForTimeout(50);
 const part={sessionId:'s',messageId:'m',partId:'p',role:'assistant',contentType:'reasoning',operation:'append'};
 for(const [offset,message,data,source,kind] of [[1,'Alpha',part,'opencode','provider_reasoning'],[2,'intervening check',undefined,'controller','output'],[3,' beta',part,'opencode','provider_reasoning'],[4,'Corrected',{...part,operation:'replace'},'opencode','provider_reasoning']]){const item={...event(100000+offset),message,data,source,kind};for(const res of subscribers)res.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);}
 await page.getByText('Corrected',{exact:true}).waitFor();
 assert.equal(await page.locator('.logrow[data-part] .message').allTextContents().then(text=>text.join('')),'Corrected','snapshot correction replaces every earlier fragment for that part');
 const started={...event(100005),source:'check',kind:'started',message:'cargo test heredoc',data:{id:'scenario-heredoc'}};for(const res of subscribers)res.write(`id: ${started.seq}\ndata: ${JSON.stringify(started)}\n\n`);
 await page.locator('#current-check').getByText('scenario-heredoc',{exact:true}).waitFor();
 assert.notEqual(await page.locator('#last-activity strong').textContent(),'Unknown');
 const finished={...event(100006),source:'check',kind:'finished',message:'scenario-heredoc: exit 0',data:{id:'scenario-heredoc'}};for(const res of subscribers)res.write(`id: ${finished.seq}\ndata: ${JSON.stringify(finished)}\n\n`);
 await page.locator('#current-check').getByText('None',{exact:true}).waitFor();
 await page.locator('.log').evaluate(node=>{node.scrollTop=10;});await page.waitForTimeout(50);
 for(let seq=100007;seq<=103006;seq++){const item={...event(seq),message:`live ${seq}`};for(const res of subscribers)res.write(`id: ${seq}\ndata: ${JSON.stringify(item)}\n\n`);}
 await page.getByRole('button',{name:/Follow live.*3000/}).waitFor();
 assert.ok(await page.locator('.logrow').count()<=1500,'paused history has a bounded DOM');
 await page.getByRole('button',{name:/Follow live/}).click();await page.waitForTimeout(100);
 assert.deepEqual(errors,[]);console.log('PASS: delayed selection, single stream, 100,000-event history paging/search/evidence, bounded paused rows, unread and Follow live.');
}finally{await browser.close();for(const res of subscribers)res.end();await new Promise(resolve=>server.close(resolve));}
