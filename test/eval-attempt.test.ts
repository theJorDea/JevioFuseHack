import assert from 'node:assert/strict';
import test from 'node:test';
import { runAttempt } from '../scripts/eval-attempt.mjs';
import { modelInput, verifySource } from '../scripts/eval-candidate.mjs';
const privateText = 'do-not-record-this-content';
const model = 'fixture/model-A';
const choice = (content:string, reason='stop', extra={}) => ({finish_reason:reason,message:{role:'assistant',content,...extra}});
const success = (content:string) => ({ model, choices:[choice(content)], usage:{prompt_tokens:13,completion_tokens:21,total_tokens:34} });
const opts = {model,repeat:2,packet:{task:'Fix intent',files:{'src/task-intent.ts':privateText}},systemPrompt:'Return source only',temperature:0,maxOutputTokens:1024,timeoutMs:2000,
  verify:()=>({verified:true,checks:{target:'PASS',control:'PASS'}})};
const noVerify = ()=>{throw Error('verifier unexpectedly called');};
test('one Chat request with whitelisted packet; preserve raw source for verifier only',async()=>{
  let calls=0, checks=0; const source='\nexport const value = 42; // '+privateText+'\n';
  const r=await runAttempt({...opts,packet:{...opts.packet,gold:privateText,files:{...opts.packet.files,'secret-test':42}},fetchImpl:async(url,init)=>{
    calls++; assert.equal(url,'/v1/chat/completions'); assert.equal(init.method,'POST'); assert.equal(init.redirect,'error');assert.ok(init.signal);
    const b=JSON.parse(init.body); assert.equal(b.model,model);assert.equal(b.temperature,0);assert.equal(b.max_completion_tokens,1024);assert.equal(b.stream,false);assert.equal(b.n,1);
    assert.deepEqual(b.messages,[{role:'system',content:opts.systemPrompt},{role:'user',content:JSON.stringify(opts.packet)}]);
    return Response.json({...success(source),id:'chatcmpl-completion-id',costMicros:1000},{headers:{'x-request-id':'Req_0007:A'}});
  },verify:(got)=>{checks++;assert.equal(got,source);return opts.verify();}});
  assert.equal(calls,1);assert.equal(checks,1);assert.equal(r.requestId,'Req_0007:A');assert.equal(r.status,'verified');assert.equal(r.costMicros,null);
  assert.equal(r.regression,false);assert.equal(r.accepted,null);assert.equal(r.task,'task-intent-questions');assert.equal(r.repeat,2);assert.equal(r.model,model);assert.equal(r.verified,true);assert.ok(r.durationMs>=0);
  assert.deepEqual(r.usage,success(source).usage);assert.ok(!JSON.stringify(r).includes(privateText));
});
test('HTTP, transport, provider errors and unsafe request IDs never leak details',async()=>{
  for (const fetchImpl of [()=>{throw Error(privateText)},()=>new Response(privateText,{status:429,headers:{'x-request-id':'sk-private'}}),()=>Response.json({error:{message:privateText}})]) {
    let calls=0;const r=await runAttempt({...opts,fetchImpl:()=>{calls++;return fetchImpl()},verify:noVerify});
    assert.equal(calls,1);assert.equal(r.status,'api_error');assert.equal(r.requestId,null);assert.equal(r.regression,null);assert.ok(!JSON.stringify(r).includes(privateText));
  }
  await assert.rejects(runAttempt({...opts,fetchImpl:undefined}),/Invalid attempt configuration/);
});
test('refusal, truncation, route changes and invalid completions never reach verifier',async()=>{
  for (const [data,status] of [[{choices:[choice('','stop',{refusal:privateText})]},'refused'],[{choices:[choice(privateText,'content_filter')]},'refused'],[{choices:[choice(privateText,'length')]},'truncated'],[{...success(privateText),model:'other'},'model_mismatch'],
    [{choices:[choice('```ts\n'+privateText+'\n```')]},'invalid'],[{choices:[choice('','tool_calls')]},'invalid'],[{choices:[]},'invalid'],[{choices:[choice(privateText),choice(privateText)]},'invalid'],[success('a'.repeat(32769)),'invalid']] as const) {
    const r=await runAttempt({...opts,fetchImpl:()=>Response.json(data),verify:noVerify});assert.equal(r.status,status);assert.equal(r.costMicros,null);assert.ok(!JSON.stringify(r).includes(privateText));
  }
});
test('response size bounded by streamed bytes, including without declared length; body aborted on timeout',async()=>{
  let pulls=0,cancelled=false;
  const oversized=new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(65536))},cancel(){cancelled=true}}));
  assert.equal((await runAttempt({...opts,fetchImpl:()=>oversized,verify:noVerify})).status,'invalid');assert.ok(cancelled);assert.ok(pulls<9);
  let aborted=false;
  const stalled=()=>new Response(new ReadableStream({cancel(){aborted=true}}));
  for(const transport of [stalled,()=>new Promise(()=>{})]) assert.equal((await runAttempt({...opts,fetchImpl:transport,verify:noVerify,timeoutMs:25})).status,'timeout');
  assert.ok(aborted);
});
test('uses real isolated verifier; failing control, invalid source and worker error remain distinguishable',async()=>{
  const packet=await modelInput();
  for (const [source,status,regression] of [[packet.files['src/task-intent.ts'],'not_verified',false],['export const isImplementationRequest = () => false','not_verified',true],['broken ??? syntax','invalid',null]] as const) {
    const r=await runAttempt({...opts,packet,fetchImpl:()=>Response.json(success(source)),verify:verifySource});assert.equal(r.status,status);assert.equal(r.regression,regression);assert.equal(r.verified,false);
  }
  const r=await runAttempt({...opts,fetchImpl:()=>Response.json(success('code')),verify:()=>{throw Error(privateText)}});assert.equal(r.status,'verification_error');assert.equal(r.regression,null);assert.ok(!JSON.stringify(r).includes(privateText));
});
test('invalid token counters and completion IDs are not used as usage or request IDs',async()=>{
  const r=await runAttempt({...opts,fetchImpl:()=>Response.json({...success('code'),id:'completion-only',usage:{prompt_tokens:-1,completion_tokens:'20',total_tokens:0}})});
  assert.equal(r.requestId,null);assert.deepEqual(r.usage,{total_tokens:0});
});
