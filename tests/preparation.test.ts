import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from '../src/process.ts';
test('baseline preparation rejects a Cargo suite that executes no tests', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jarvis-baseline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const cargo=path.join(root,'cargo');
  for(const passed of [0,1]) {
    await fs.writeFile(cargo,`#!/bin/sh\necho 'test result: ok. ${passed} passed; 0 failed; 0 ignored; 3 filtered out;'\n`,{mode:0o755});
    const result=await exec('python3',['docker/prepare.py','baseline',JSON.stringify({suite:['cargo','test','--locked','--offline']})],{env:{...process.env,PATH:root+path.delimiter+process.env.PATH}});
    assert.equal(result.code===0,passed===1,result.stdout+result.stderr);
  }
});
