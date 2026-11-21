import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateFunction} from '../scripts/eval-team-engine.mjs';
const target=(input:string,expected:string|boolean)=>({kind:'target',input,expected});
const control=(input:string,expected:string|boolean)=>({kind:'control',input,expected});
const pair=[target('a','a'),control('b','b')];

test('team function: named TS export, fresh guests and exact typed results in order',()=>{
  const source='let used=false;export function apply(s:string): string|boolean {if(used)throw Error();used=true;return s==="boolean"?true:s;}';
  const text='\u0000🌲\ud800';
  const checks=[control('boolean','true'),target(text,text),target('boolean',true),control('true',true)];
  assert.deepEqual(evaluateFunction(source,'apply',checks),{results:['FAIL','PASS','PASS','FAIL'],checks:{target:'PASS',control:'FAIL'},verified:false});
  assert.equal(evaluateFunction(source,'apply',pair).verified,true);
});
test('team function: source errors, unsupported output, promises and missing imports are INVALID',()=>{
  for(const source of ['export const apply =','export const other=1','export async function apply(s){return s}',
    'import fs from "node:fs";export function apply(){return fs}', 'export function apply(){throw Error("private")}',
    'export function apply(){return {toJSON(){return "a"}}}']){
    assert.deepEqual(evaluateFunction(source,'apply',pair).results,['INVALID','INVALID']);
  }
});
test('team function: output byte cap and isolated time budget',()=>{
  const source='export const apply=s=>s==="big"?"🌲".repeat(1025):s==="loop"?(()=>{while(true){}})():s;';
  const checks=[target('big','x'),target('ok','bad'),control('loop',true),control('🌲'.repeat(1024),'🌲'.repeat(1024))];
  assert.deepEqual(evaluateFunction(source,'apply',checks),{results:['INVALID','FAIL','INVALID','PASS'],checks:{target:'INVALID',control:'INVALID'},verified:false});
});
test('team function: infrastructure errors throw a fixed message and no verdict',()=>{
  const executable=process.execPath;
  try {
    process.execPath=executable+'.missing-test-binary';
    assert.throws(()=>evaluateFunction('export const apply=s=>"private"','apply',pair),{message:'Team evaluation worker failed; no behavioral verdict'});
  }finally{process.execPath=executable;}
});
test('team function: input errors never echo private material or produce vacuous PASS',()=>{
  for(const checks of [[],[target('','')],[...pair,target('secret'.repeat(1000),'')],[...pair,control('','x'.repeat(4097))],Array(65).fill(pair[0])]){
    assert.throws(()=>evaluateFunction('private source','apply',checks),/^Error: Invalid team checks?$/);
  }
});
