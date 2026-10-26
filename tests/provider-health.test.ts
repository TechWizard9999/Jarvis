import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderCooldown, providerError, providerAttemptHeaders, recordProviderFailure } from '../src/provider-health.ts';

test('provider health stores canonical protocol metadata and never arbitrary echoed messages',()=>{
  const error=providerError({error:{message:'secret key and PRIVATE prompt',code:'secret-key',type:'PRIVATE prompt'}},200)!;
  assert.deepEqual(error,{kind:'provider_error',message:'Model provider returned an internal error.',retryable:true});
  const details={requestId:'logical-request',httpStatus:200,meaningfulOutput:false,usableOutput:false,identity:'safe-hash'};
  const first=recordProviderFailure(undefined,error,details),second=recordProviderFailure(first,error,details),third=recordProviderFailure(second,error,details);
  assert.equal(first.consecutiveFailures,1);assert.equal(second.circuitOpen,false);assert.equal(third.circuitOpen,true);assert.equal(third.consecutiveFailures,3);assert.equal((third as any).identity,undefined);
  assert.equal(recordProviderFailure(third,error,{...details,identity:'different-settings'}).consecutiveFailures,1);
  assert.equal(recordProviderFailure(undefined,error,{...details,meaningfulOutput:true,usableOutput:false}).circuitOpen,true,'delivered reasoning also forbids replay');
});

test('only allowlisted safe request IDs and numeric rate headers enter evidence',()=>{
  assert.deepEqual(providerAttemptHeaders(new Headers({'x-request-id':'safe-request-123','retry-after':'120','x-ratelimit-remaining-tokens':'42','x-ratelimit-limit-requests':'echo private content','set-cookie':'secret'}),'fixture-secret'),{requestId:'safe-request-123',rateLimit:{'retry-after':'120','x-ratelimit-remaining-tokens':'42'}});
  assert.deepEqual(providerAttemptHeaders(new Headers({'x-request-id':'fixture-secret','x-ratelimit-reset-requests':'PRIVATE prompt'}),'fixture-secret'),{});
});

test('shared endpoint/account cooldown cannot be shortened and cancellation interrupts the wait',async()=>{
  const cooldown=new ProviderCooldown(),signal=new AbortController();cooldown.defer('account',0.06);cooldown.defer('account',0.001);
  const started=Date.now();await Promise.all([cooldown.wait('account',signal.signal),cooldown.wait('account',signal.signal),cooldown.wait('different-account',signal.signal)]);
  assert.ok(Date.now()-started>=45,'both connections wait for the same known account cooldown');
  cooldown.defer('account',60);const pending=cooldown.wait('account',signal.signal);signal.abort(new Error('cancelled'));await assert.rejects(pending,/abort/i);
});

test('NVIDIA nvcf-reqid is captured safely without storing an echoed credential',()=>{
  const id='123e4567-e89b-12d3-a456-426614174000';
  assert.equal(providerAttemptHeaders(new Headers({'nvcf-reqid':id}),'fixture-secret').requestId,id);
  assert.equal(providerAttemptHeaders(new Headers({'nvcf-reqid':'fixture-secret'}),'fixture-secret').requestId,undefined);
});

test('Retry-After dates are canonicalized before evidence so ignored comments cannot leak',()=>{
  const value=providerAttemptHeaders(new Headers({'retry-after':'Wed, 21 Oct 2026 07:28:00 GMT (PRIVATE PROMPT)'}),'fixture-secret');
  assert.equal(value.rateLimit?.['retry-after'],'Wed, 21 Oct 2026 07:28:00 GMT');assert.doesNotMatch(JSON.stringify(value),/PRIVATE PROMPT/);
});
