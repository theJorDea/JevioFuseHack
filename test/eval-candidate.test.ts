import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {modelInput,verifySource,runnableCaseIds,loaderLifecycleExcerpt} from '../scripts/eval-candidate.mjs';

test('model bundle has only original work and task; base fails, historical fix passes',async()=>{
  const packet=await modelInput();assert.deepEqual(Object.keys(packet).sort(),['files','task']);
  assert.deepEqual(Object.keys(packet.files),['src/task-intent.ts']);
  assert.deepEqual(verifySource(packet.files['src/task-intent.ts']).checks,{target:'FAIL',control:'PASS'});
  const gold=await readFile(new URL('../benchmark/evaluation/task-intent-questions/gold-task-intent.ts.fixture',import.meta.url),'utf8');
  assert.equal(verifySource(gold).verified,true);
});
const parserId = 'text-tool-line-continuation';
const parserGold = new URL('../benchmark/evaluation/text-tool-line-continuation/gold-parser.ts.fixture',import.meta.url);
test('parser input is the base excerpt only; confirm historical outcomes and both line endings',async()=>{
  assert.ok(runnableCaseIds.includes(parserId));
  const packet = await modelInput(parserId);
  assert.deepEqual(Object.keys(packet).sort(),['files','task']);
  assert.deepEqual(Object.keys(packet.files),['src/agent.ts']);
  assert.deepEqual(verifySource(packet.files['src/agent.ts'],parserId).checks,{target:'FAIL',control:'PASS'});
  const gold = await readFile(parserGold,'utf8');
  assert.deepEqual(verifySource(gold,parserId).checks,{target:'PASS',control:'PASS'});
  for (const ending of ['\\r','\\n']) {
    const guard = ending==='\\r' ? 'content.includes("\\r")' : '!content.includes("\\r") && content.includes("\\\\\\n")';
    const mutant = gold.replace('if (allowedNames.has("write_file"))',`if (${guard}) return []; if (allowedNames.has("write_file"))`);
    assert.deepEqual(verifySource(mutant,parserId).checks,{target:'FAIL',control:'PASS'});
  }
  await assert.rejects(modelInput('unknown'),/Unknown/);
});
test('parser output requires exact name and complete decoded arguments, not a guest verdict',async()=>{
  const gold = await readFile(parserGold,'utf8');
  for(const mutant of [gold.replace('name, arguments: argumentsJson','name: "other", arguments: argumentsJson'),gold.replace('arguments: argumentsJson','arguments: "{}"')]){
    assert.deepEqual(verifySource(mutant,parserId).checks,{target:'FAIL',control:'FAIL'});
  }
  for(const value of ['"PASS"','[{name:"lookup",arguments:"x".repeat(4500)}]','[{name:"lookup",arguments:"broken"}]']) {
    assert.deepEqual(verifySource(`export function parseFallbackToolCalls(){return ${value}}`,parserId).checks,{target:'INVALID',control:'INVALID'});
  }
});
test('picker packet is a single class-method excerpt; observes focus, dismissal and empty-session feedback',async()=>{
  const id='session-picker-focus',packet=await modelInput(id);
  assert.deepEqual(Object.keys(packet.files),['src/picker-method.ts']);
  const base=packet.files['src/picker-method.ts'];
  assert.deepEqual(verifySource(base,id).checks,{target:'FAIL',control:'PASS'});
  const gold=await readFile(new URL('../benchmark/evaluation/session-picker-focus/gold-picker-method.ts.fixture',import.meta.url),'utf8');
  assert.deepEqual(verifySource(gold,id).checks,{target:'PASS',control:'PASS'});
  for(const mutated of [gold.replace('handle.hide();',''), gold.replace('this.tui.setFocus(this.editor);',''),gold.replace('value: session.id','value: session.title')]) {
    assert.deepEqual(verifySource(mutated,id).checks,{target:'FAIL',control:'PASS'});
  }
  assert.deepEqual(verifySource(gold.replace('No saved sessions in this workspace.','No results'),id).checks,{target:'PASS',control:'FAIL'});
  assert.deepEqual(verifySource('private async showSessionPicker(){ return "PASS" }',id).checks,{target:'FAIL',control:'FAIL'});
  assert.deepEqual(verifySource('private async showSessionPicker(){ await new Promise(()=>{}) }',id).checks,{target:'INVALID',control:'INVALID'});
});
test('loader excerpt verifies initial, pending and finished display independently inside QuickJS',async()=>{
  const id='idle-loader-status',packet=await modelInput(id);
  assert.deepEqual(Object.keys(packet.files),['src/loader-lifecycle.ts']);
  const base=packet.files['src/loader-lifecycle.ts']; assert.doesNotMatch(base,/^import /m);
  assert.deepEqual(verifySource(base,id).checks,{target:'FAIL',control:'PASS'});
  const bytes=await readFile(new URL('../benchmark/evaluation/idle-loader-status/gold-interactive-tui.ts.fixture',import.meta.url));
  const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(bytes).digest('hex'),'e9697c8efd1471a8fe56b797be1e7f6f9c52aae0133273d82ee048adc398dcef');
  const gold=loaderLifecycleExcerpt(bytes.toString('utf8'));
  assert.deepEqual(verifySource(gold,id).checks,{target:'PASS',control:'PASS'});
  for(const mutant of [gold.replace('dim, "", { frames: [] }','dim, "Готово", { frames: [] }'),gold.replace('this.loader.setIndicator({ frames: [] });',''),gold.replace('this.loader.setMessage("");','')]) {
    assert.deepEqual(verifySource(mutant,id).checks,{target:'FAIL',control:'PASS'});
  }
  assert.deepEqual(verifySource(gold.replace('this.loader.start();','this.loader.stop();'),id).checks,{target:'PASS',control:'FAIL'});
  assert.deepEqual(verifySource('run(){return "PASS"} handleSubmit(){return "PASS"}',id).checks,{target:'INVALID',control:'INVALID'});
  const isolated=gold.replace('this.refreshHeader();','if(typeof process!=="undefined"||typeof fetch!=="undefined"||typeof require!=="undefined")throw 0;this.refreshHeader();');
  assert.equal(verifySource(isolated,id).verified,true);
});
test('Kimi verifier measures full provider requests; preserves non-Kimi temperature precedence',async()=>{
  const id='kimi-temperature', packet=await modelInput(id);
  assert.deepEqual(Object.keys(packet.files),['src/provider/openai-compatible.ts']);
  const base=packet.files['src/provider/openai-compatible.ts'];
  assert.deepEqual(verifySource(base,id).checks,{target:'FAIL',control:'PASS'});
  const gold=await readFile(new URL('../benchmark/evaluation/kimi-temperature/gold-provider.ts.fixture',import.meta.url),'utf8');
  assert.deepEqual(verifySource(gold,id).checks,{target:'PASS',control:'PASS'});
  const condition='/\\bkimi\\b/i.test(role.model)';
  for (const [mutant,target,control] of [
    [gold.replace(condition,'true'),'PASS','FAIL'],
    [gold.replace(condition,'role.model === "moonshot/Kimi-K2.7"'),'FAIL','PASS'],
    [gold.replace(condition,'/kimi/i.test(role.model)'),'PASS','FAIL'],
    [gold.replace('stream: false','stream: true'),'FAIL','FAIL'],
    [gold.replace('method: "POST"','method: "GET"'),'FAIL','FAIL'],
    ['export class OpenAICompatibleClient {async complete(){return {content:"OK"}}}','FAIL','FAIL'],
  ]) assert.deepEqual(verifySource(mutant,id).checks,{target,control});
});
test('outside verifier rejects regression, invalid source and non-boolean verdict',()=>{
  assert.deepEqual(verifySource('export function isImplementationRequest(){return false}').checks,{target:'PASS',control:'FAIL'});
  for(const code of ['this is invalid TypeScript!', 'export function isImplementationRequest(){return "PASS"}']) {
    assert.deepEqual(verifySource(code).checks,{target:'INVALID',control:'INVALID'});
  }
});
test('guest has no Node globals, fetch or file loader, and nonterminating guest is interrupted',()=>{
  const body='export function isImplementationRequest(){return typeof process!=="undefined" || typeof fetch!=="undefined" || typeof require!=="undefined"}';
  assert.deepEqual(verifySource(body).checks,{target:'PASS',control:'FAIL'});
  assert.equal(verifySource('import fs from "node:fs";export function isImplementationRequest(){return !!fs}').checks.target,'INVALID');
  assert.equal(verifySource('export function isImplementationRequest(){while(true){}}').checks.target,'INVALID');
});
