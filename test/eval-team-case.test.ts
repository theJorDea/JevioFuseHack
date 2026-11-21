import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,link,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadTeamCase,readCandidateFile} from '../scripts/eval-team-case.mjs';
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const privateError={name:'Error',message:'Invalid local evaluation input'};
async function fixture(t:TestContext){
 const dir=await mkdtemp(path.join(await realpath(tmpdir()),'private-team-case-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const base='\ufeff// base 🤖\r\n',gold='throw Error("must not execute me")';
 const m={schema:'jevio-team-case/v1',task:'private task description',entry:'$evaluate1',base:{file:'base.ts',sha256:hash(base)},gold:{file:'gold.js',sha256:hash(gold)},checks:[{kind:'target',input:'',expected:true},{kind:'control',input:'y',expected:'ok'}]};
 const manifest=path.join(dir,'case.json');
 await Promise.all([writeFile(manifest,JSON.stringify(m)),writeFile(path.join(dir,m.base.file),base),writeFile(path.join(dir,m.gold.file),gold)]);
 return {dir,manifest,m,base,gold};
}
test('loads inert sibling bytes; identity binds exact manifest bytes and byte pins, not location',async t=>{
 const a=await fixture(t),b=await fixture(t);const c=await loadTeamCase(a.manifest);
 assert.deepEqual(c,{task:a.m.task,entry:a.m.entry,baseSource:a.base,goldSource:a.gold,checks:a.m.checks,caseSha256:hash(JSON.stringify([a.m.schema,hash(JSON.stringify(a.m)),a.m.base.sha256,a.m.gold.sha256]))});
 assert.deepEqual(await loadTeamCase(b.manifest),c);
 await writeFile(a.manifest,JSON.stringify(a.m,null,2));assert.notEqual((await loadTeamCase(a.manifest)).caseSha256,c.caseSha256);
 await writeFile(a.manifest,JSON.stringify(a.m));await writeFile(path.join(a.dir,'base.ts'),a.base+' ');await assert.rejects(loadTeamCase(a.manifest),privateError);
 a.m.base.sha256=hash(a.base+' ');await writeFile(a.manifest,JSON.stringify(a.m));assert.notEqual((await loadTeamCase(a.manifest)).caseSha256,c.caseSha256);
});
test('rejects unsafe pins, unknown fields, invalid schema, entry and check matrix without private diagnostics',async t=>{
 const {m,manifest}=await fixture(t),target=m.checks[0],control=m.checks[1];
 for(const change of [{schema:'other'},{task:'   '},{entry:'a.b'},{extra:'private metadata'},{checks:[target]},
 {checks:[target,{...control,input:target.input}]},{checks:[target,{...control,kind:'unknown'}]},
 {checks:[target,{...control,input:'🤖'.repeat(513)}]},{checks:[target,{...control,expected:'x'.repeat(1025)}]},
 {checks:[target,{...control,expected:12}]},{checks:Array.from({length:13},(_,i)=>({...(i?control:target),input:String(i)}))},
 {base:{...m.base,sha256:'a'.repeat(63)}},{gold:{...m.base,file:'BASE.ts'}},
 ...['../base.ts','nested/base.ts','nested\\base.ts','C:base.ts','a.ts:alt.js','NUL.js','com1.ts','LPT9.test.js','BASE~1.ts','base.ts.','base.ts ','base.txt'].map(file=>({base:{...m.base,file}}))]){
  await writeFile(manifest,JSON.stringify({...m,...change}));await assert.rejects(loadTeamCase(manifest),privateError);
 }
});
test('rejects hardlinks, link directories, nonregular files, oversized bytes and invalid UTF-8',async t=>{
 const {m,dir,manifest}=await fixture(t),file=path.join(dir,m.base.file),alias=path.join(dir,'alias.js');
 await link(file,alias);await assert.rejects(loadTeamCase(manifest),privateError);await assert.rejects(readCandidateFile(alias),privateError);await rm(alias);
 await rm(file);await mkdir(file);await assert.rejects(loadTeamCase(manifest),privateError);await rm(file,{recursive:true});
 for(const data of [Buffer.alloc(32769,97),Buffer.from([0x80]),Buffer.alloc(0)]){
  await writeFile(file,data);await assert.rejects(readCandidateFile(file),privateError);m.base.sha256=hash(data);await writeFile(manifest,JSON.stringify(m));await assert.rejects(loadTeamCase(manifest),privateError);
 }
 await writeFile(file,Buffer.alloc(32768,97));assert.equal((await readCandidateFile(file)).length,32768);
 const targetDir=path.join(dir,'inside');await mkdir(targetDir);await writeFile(path.join(targetDir,'script.js'),'// ok');
 const linked=path.join(dir,'linked');await symlink(targetDir,linked,process.platform==='win32'?'junction':'dir');await assert.rejects(readCandidateFile(path.join(linked,'script.js')),privateError);
 await writeFile(manifest,Buffer.from([0xff]));await assert.rejects(loadTeamCase(manifest),privateError);
 await writeFile(manifest,Buffer.alloc(131073,32));await assert.rejects(loadTeamCase(manifest),privateError);
});
