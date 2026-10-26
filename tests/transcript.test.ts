import test from 'node:test';
import assert from 'node:assert/strict';

test('transcript reconciles deltas and cumulative snapshots once with provider identities and roles', async () => {
  const module = await import('../src/transcript.ts').catch(() => ({})) as any;
  assert.equal(typeof module.Transcript, 'function', 'transcript normalization is available');
  const transcript = new module.Transcript('session-1');
  const chunks: any[] = [];
  const push = (event: unknown) => chunks.push(...transcript.accept(event));
  push({type:'message.updated',properties:{info:{id:'message-1',sessionID:'session-1',role:'assistant'}}});
  push({type:'message.part.updated',properties:{part:{id:'part-1',messageID:'message-1',sessionID:'session-1',type:'reasoning',text:''}}});
  push({type:'message.part.delta',properties:{sessionID:'session-1',messageID:'message-1',partID:'part-1',field:'text',delta:'First'}});
  push({type:'message.part.updated',properties:{part:{id:'part-1',messageID:'message-1',sessionID:'session-1',type:'reasoning',text:'First'}}});
  push({type:'message.part.delta',properties:{sessionID:'session-1',messageID:'message-1',partID:'part-1',field:'text',delta:' thought'}});
  push({type:'message.part.updated',properties:{part:{id:'part-1',messageID:'message-1',sessionID:'session-1',type:'reasoning',text:'First thought'}}});
  assert.equal(chunks.map((chunk: any) => chunk.message).join(''), 'First thought');
  assert.ok(chunks.every((chunk: any) => chunk.kind === 'provider_reasoning' && chunk.data.role === 'assistant' && chunk.data.messageId === 'message-1' && chunk.data.partId === 'part-1'));
  assert.deepEqual(transcript.accept({type:'message.part.updated',properties:{part:{id:'other',messageID:'other',sessionID:'other-session',type:'text',text:'private other session'}}}), []);
});

test('reconnect snapshots repair a missing suffix and make conflicting snapshots explicit replacements', async () => {
  const module = await import('../src/transcript.ts').catch(() => ({})) as any;
  assert.equal(typeof module.Transcript, 'function', 'transcript normalization is available');
  const transcript = new module.Transcript('s');
  transcript.reconcile([{info:{id:'m',sessionID:'s',role:'user'},parts:[{id:'p',messageID:'m',sessionID:'s',type:'text',text:'Hello'}]}]);
  const recovered = transcript.reconcile([{info:{id:'m',sessionID:'s',role:'user'},parts:[{id:'p',messageID:'m',sessionID:'s',type:'text',text:'Hello world'}]}]);
  assert.equal(recovered.length,1); assert.equal(recovered[0].message,' world'); assert.equal(recovered[0].data.role,'user');
  assert.deepEqual(transcript.reconcile([{info:{id:'m',sessionID:'s',role:'user'},parts:[{id:'p',messageID:'m',sessionID:'s',type:'text',text:'Hello world'}]}]),[]);
  const corrected = transcript.reconcile([{info:{id:'m',sessionID:'s',role:'user'},parts:[{id:'p',messageID:'m',sessionID:'s',type:'text',text:'Corrected'}]}]);
  assert.equal(corrected[0].data.operation,'replace'); assert.equal(corrected[0].message,'Corrected');
  assert.throws(() => transcript.reconcile({}), /message list/);
});

test('recovery ignores buffered deltas already covered by backfill and detects missing earlier messages', async () => {
  const {Transcript}=await import('../src/transcript.ts');const transcript=new Transcript('s');
  transcript.reconcile([{info:{id:'m',sessionID:'s',role:'assistant'},parts:[{id:'p',messageID:'m',sessionID:'s',type:'text',text:'Hello'}]}]);
  assert.equal(typeof (transcript as any).recover,'function','source reconnect supports overlap reconciliation');
  const recovered=(transcript as any).recover([{info:{id:'m',sessionID:'s',role:'assistant'},parts:[{id:'p',messageID:'m',sessionID:'s',type:'text',text:'Hello world'}]}]);
  const chunks=[...recovered,...transcript.accept({type:'message.part.delta',properties:{messageID:'m',partID:'p',delta:' world'}}),...transcript.accept({type:'message.part.updated',properties:{part:{id:'p',messageID:'m',type:'text',text:'Hello world'}}}),...transcript.accept({type:'message.part.delta',properties:{messageID:'m',partID:'p',delta:'!'}})];
  assert.equal(chunks.map(chunk=>chunk.message).join(''),' world!');
  assert.throws(()=>(transcript as any).recover([]),/missing earlier message/);
});
