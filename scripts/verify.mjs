/** Reproducible local release gate. Local fixtures only; no live provider or GitHub writes. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = path.join(process.cwd(), 'state', 'verification', new Date().toISOString().replaceAll(':', '-'));
await fs.mkdir(directory, {recursive:true});
const steps = [
  ['typecheck', 'node_modules/typescript/bin/tsc', '--noEmit'],
  ['unit', '--test', ...((await fs.readdir('tests')).filter(name=>name.endsWith('.test.ts')).sort().map(name=>`tests/${name}`))],
  ['activity', 'scripts/activity-scroll-e2e.mjs'],
  ['monitoring', 'scripts/monitoring-e2e.mjs'],
  ['cargo', 'scripts/e2e.ts'],
  ['adapter', 'scripts/adapter-e2e.ts'],
  ['publisher', 'scripts/publisher-e2e.ts'],
];
const results=[];
for (const [name,...args] of steps) {
  console.log(`Checking ${name}`); const started=Date.now(); let output='';
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env:process.env,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
    child.on('error',reject); child.on('close',resolve);
  });
  await fs.writeFile(path.join(directory,`${name}.log`),output);
  results.push({name,exitCode:code,durationMs:Date.now()-started});
  await fs.writeFile(path.join(directory,'results.json'),JSON.stringify(results,null,2)+'\n');
  if(code!==0){process.exitCode=1;break;}
}
console.log(`Verification evidence: ${directory}`);
