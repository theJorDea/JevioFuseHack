import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import spec from '../benchmark/evaluation/lmstudio-tool-default/case.mjs';
import desc from '../scripts/eval-adapters/lmstudio-tool-default.mjs';
import {modelInput,verifySource} from '../scripts/eval-candidate.mjs';

async function projected(edition:'base'|'gold') {
  const [,file,hash]=spec.files[edition][0];
  const source=await readFile(new URL(`../benchmark/evaluation/lmstudio-tool-default/${file}`,import.meta.url),'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),hash);
  return desc.project(source,edition);
}
function checks(source:string){ return verifySource(source,desc.id).checks; }
test('provider merge projection preserves historical failure, fix and configured controls without filesystem loading',async()=>{
  const base=await projected('base'), gold=await projected('gold');
  const packet=await modelInput(desc.id);
  assert.deepEqual(packet.files,{[desc.path]:base});assert.doesNotMatch(base,/node:fs|loadConfig\(/);
  assert.deepEqual(checks(base),{target:'FAIL',control:'PASS'});
  assert.deepEqual(checks(gold),{target:'PASS',control:'PASS'});
});
for(const [label,fields] of [['discard config','baseUrl:provider.baseUrl, toolMode:provider.toolMode,'],['drop headers','...provider, headers:undefined,'],['replace transport','...provider, transport:"broken",']]) test(`LM Studio verifier rejects ${label}`,async()=>{
  const gold=await projected('gold');
  assert.equal(gold.split('...provider,').length,2);
  assert.deepEqual(checks(gold.replace('...provider,',fields)),{target:'FAIL',control:'FAIL'});
});
test('LM Studio verifier rejects overwriting explicit modes, name-only matching, and port prefix matching',async()=>{
  const gold=await projected('gold');
  const override=gold.replace('!provider.toolMode &&','true &&');
  const nameOnly=gold.replace('|| /^http:', '|| false && /^http:');
  const overbroad=gold.replace('1234(?:\\/|$)', '1234');
  for(const candidate of [override,nameOnly,overbroad]) assert.notEqual(candidate,gold);
  assert.deepEqual(checks(override),{target:'PASS',control:'FAIL'});
  assert.deepEqual(checks(nameOnly),{target:'FAIL',control:'PASS'});
  assert.deepEqual(checks(overbroad),{target:'PASS',control:'FAIL'});
});
