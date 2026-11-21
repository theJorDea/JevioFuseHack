import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import descriptor from '../scripts/eval-adapters/node-test-isolation-flag.mjs';
import spec from '../benchmark/evaluation/node-test-isolation-flag/case.mjs';
import {modelInput,verifySource} from '../scripts/eval-candidate.mjs';
const runner='scripts/run-tests.mjs';
async function packet(edition:'base'|'gold'){
  const files:Record<string,string>={};
  for(const [p,name,hash] of spec.files[edition]){
    const bytes=await readFile(new URL(`../benchmark/evaluation/node-test-isolation-flag/${name}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);files[p]=bytes.toString('utf8');
  }
  return descriptor.project(files['package.json'],edition,files);
}
const check=(src:string)=>verifySource(src,descriptor.id).checks;
test('runner cannot call spawnSync without importing it', async()=>{
  const files=JSON.parse(await packet('gold'));
  files[runner]=files[runner].replace(/^import[^\n]+\n/m,'');
  assert.deepEqual(check(JSON.stringify(files)),{target:'INVALID',control:'INVALID'});
});
test('normal npm test must forward a nonzero child status too', async()=>{
  const files=JSON.parse(await packet('gold'));
  files[runner]=files[runner].replace('result.status ?? 1','files[0].includes("cloud") ? (result.status ?? 1) : 0');
  assert.deepEqual(check(JSON.stringify(files)),{target:'FAIL',control:'FAIL'});
});
test('runner multi-file task faithfully represents base and fixed commands and does not ship gold to model',async()=>{
  const base=await packet('base'),gold=await packet('gold');const input=await modelInput(descriptor.id);
  assert.equal(input.files[descriptor.path],base);assert.deepEqual(Object.keys(JSON.parse(base)),['package.json']);
  assert.match(input.task,/JSON object/);assert.deepEqual(check(base),{target:'FAIL',control:'PASS'});
  assert.deepEqual(check(gold),{target:'PASS',control:'PASS'});
});
test('runner rejects wrong stable flag, argv loss, wrong cloud route, ignored child status and removed manifest metadata',async()=>{
  const files=JSON.parse(await packet('gold'));const original=files[runner];
  for(const [oldText,newText,expected] of [
    ['process.allowedNodeEnvironmentFlags.has(stableIsolationFlag)','false',{target:'PASS',control:'FAIL'}],
    ['...files,','files[0],',{target:'FAIL',control:'FAIL'}],
    ['result.status ?? 1','0',{target:'FAIL',control:'FAIL'}],
  ] as const){
    const mutated=original.replace(oldText,newText); assert.notEqual(mutated,original);
    assert.deepEqual(check(JSON.stringify({...files,[runner]:mutated})),expected);
  }
  const manifest=JSON.parse(files['package.json']);manifest.scripts['test:cloud']=manifest.scripts.test;
  assert.deepEqual(check(JSON.stringify({...files,'package.json':JSON.stringify(manifest)})),{target:'FAIL',control:'FAIL'});
  delete manifest.dependencies;
  assert.deepEqual(check(JSON.stringify({...files,'package.json':JSON.stringify(manifest)})),{target:'INVALID',control:'INVALID'});
});
