import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { modelInput, verifySource } from '../scripts/eval-candidate.mjs';
import spec from '../scripts/eval-adapters/provider-stream-recovery.mjs';

const { id, path } = spec;
const gold = await readFile(new URL('../benchmark/evaluation/provider-stream-recovery/gold-provider.ts.fixture',import.meta.url),'utf8');
const check = (source:string) => verifySource(source,id);
function mutate(old:string,value:string) {
  assert.ok(gold.includes(old)); return gold.replace(old,value);
}
test('stream recovery accepts exact historical fix; original is healthy only without interruption',async()=>{
  const packet = await modelInput(id);
  assert.deepEqual(Object.keys(packet.files),[path]);
  assert.deepEqual(check(packet.files[path]).checks,{target:'FAIL',control:'PASS'});
  assert.deepEqual(check(gold).checks,{target:'PASS',control:'PASS'});
});
test('stream verifier requires preserved request semantics, real fallback reply, and healthy deltas',()=>{
  const dropped=mutate('onDelta({ type: "text", delta: delta.content });','/* lost incremental update */');
  assert.deepEqual(check(dropped).checks,{target:'PASS',control:'FAIL'});
  const changed=mutate('if (isTransientStreamError(error)) return this.complete(request);','if (isTransientStreamError(error)) return this.complete({...request, messages:[]});');
  assert.deepEqual(check(changed).checks,{target:'FAIL',control:'PASS'});
  const fake=mutate('if (isTransientStreamError(error)) return this.complete(request);','if (isTransientStreamError(error)) return modelResponse({content:"Recovered"});');
  assert.deepEqual(check(fake).checks,{target:'FAIL',control:'PASS'});
});
test('stream verifier does not trust a candidate verdict or allow host I/O',()=>{
  assert.equal(check('export class OpenAICompatibleClient {async complete(){return {content:"PASS"}}}').verified,false);
  assert.equal(check('import fs from "node:fs"; export class OpenAICompatibleClient {complete(){return fs}}').verified,false);
});
