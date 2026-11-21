import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {modelInput,verifySource} from '../scripts/eval-candidate.mjs';
import adapter from '../scripts/eval-adapters/cognee-data-receipt.mjs';
const gold=adapter.project(await readFile(new URL('../benchmark/evaluation/cognee-data-receipt/gold-memory.ts.fixture',import.meta.url),'utf8'));
const verify=(s:string)=>verifySource(s,adapter.id);
const mutate=(from:string,to:string)=>{assert.ok(gold.includes(from));return gold.replace(from,to)};
test('Cognee candidate uses actual projected remember code for both existing and missing IDs',async()=>{
 const {files}=await modelInput(adapter.id);assert.deepEqual(Object.keys(files),[adapter.path]);
 assert.deepEqual(verify(files[adapter.path]).checks,{target:'FAIL',control:'PASS'});
 assert.deepEqual(verify(gold).checks,{target:'PASS',control:'PASS'});
});
test('rejects first filename match and fabricated correct ID without resolution lookups',()=>{
 const stale=mutate('for (const candidate of candidates) {','if(candidates.length)return candidates[0].id;\n        for (const candidate of candidates) {');
 assert.deepEqual(verify(stale).checks,{target:'FAIL',control:'PASS'});
 const fake=mutate('await this.resolveRememberedDataId(receipt.datasetId, filename, contentHash)','"match"');
 assert.deepEqual(verify(fake).checks,{target:'FAIL',control:'PASS'});
});
test('rejects unnecessary lookups for direct receipts and altered upload',()=>{
 const redundant=mutate('if (!receipt.dataId && receipt.datasetId)', 'if (receipt.datasetId)');
 assert.deepEqual(verify(redundant).checks,{target:'PASS',control:'FAIL'});
 const wrong=mutate('form.append("datasetName", this.dataset);','form.append("datasetName", "different");');
 assert.deepEqual(verify(wrong).checks,{target:'FAIL',control:'FAIL'});
});
