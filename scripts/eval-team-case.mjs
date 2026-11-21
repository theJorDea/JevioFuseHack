// Local data only. Never import the submitted files, follow fixture references outside
// their directory, or expose filesystem/decoder/parser diagnostics to the caller.
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const sourceLimit=32*1024, manifestLimit=128*1024;
const invalid=()=>{throw Error('Invalid local evaluation input');};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const device=/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const same=(a,b)=>a.dev===b.dev && a.ino===b.ino;
const keys=(o,names)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===names.length&&names.every(k=>Object.hasOwn(o,k));
function localPath(p){
  if(typeof p!=='string'||!p||p.includes('\0')||/^[\\/]{2}/.test(p))invalid();
  const full=path.resolve(p),root=path.parse(full).root;
  if(/^[\\/]{2}/.test(root))invalid();
  if(process.platform==='win32' && full.slice(root.length).split(path.sep).some(s=>device.test(s)||/[<>:"|?*]|[. ]$/.test(s)))invalid();
  return full;
}
async function bounded(file,limit){
  const full=localPath(file);
  const dirs=[];
  for(let p=path.dirname(full);p!==path.dirname(p);p=path.dirname(p))dirs.push(p);
  for(const dir of dirs.reverse())if(!(await lstat(dir)).isDirectory())invalid();
  const before=await lstat(full,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>limit)invalid();
  const fd=await open(full,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
    const opened=await fd.stat({bigint:true});
    if(!opened.isFile()||!same(before,opened)||opened.nlink!==1n||opened.size!==before.size)invalid();
    const bytes=Buffer.alloc(Number(opened.size)+1);let used=0;
    while(used<bytes.length){const {bytesRead}=await fd.read(bytes,used,bytes.length-used,used);if(!bytesRead)break;used+=bytesRead;}
    const end=await fd.stat({bigint:true}), named=await lstat(full,{bigint:true});
    if(used!==Number(opened.size)||!same(end,named)||!named.isFile()||end.nlink!==1n||end.size!==opened.size||end.ctimeNs!==opened.ctimeNs)invalid();
    const data=bytes.subarray(0,used);
    return {bytes:data,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data),stat:end};
  }finally{await fd.close();}
}
export async function readCandidateFile(file){
  try{return (await bounded(file,sourceLimit)).text;}catch{invalid();}
}
function pin(p){return keys(p,['file','sha256'])&&typeof p.file==='string'&&p.file.length<=255&&
  /^[a-z0-9][a-z0-9_.-]*\.(?:js|ts)$/i.test(p.file)&&!device.test(p.file)&&
  typeof p.sha256==='string'&&/^[a-f0-9]{64}$/.test(p.sha256);}
/** caseSha256 = SHA-256(UTF-8 JSON.stringify([schema, manifest byte SHA-256,
 * base byte SHA-256, gold byte SHA-256])). Formatting changes identity; paths
 * outside the manifest do not. All three hashes describe the bytes actually read. */
export async function loadTeamCase(caseFile){
  try{
    const full=localPath(caseFile), manifest=await bounded(full,manifestLimit);
    const m=JSON.parse(manifest.text);
    if(!keys(m,['schema','task','entry','base','gold','checks'])||m.schema!=='jevio-team-case/v1'||
      typeof m.task!=='string'||!m.task.trim()||m.task.length>4096||typeof m.entry!=='string'||!/^[$A-Z_a-z][$\w]{0,127}$/.test(m.entry)||
      !pin(m.base)||!pin(m.gold)||m.base.file.toLowerCase()===m.gold.file.toLowerCase()||!Array.isArray(m.checks)||m.checks.length>12)invalid();
    const kinds=new Set(),inputs=new Set();
    for(const c of m.checks){
      if(!keys(c,['kind','input','expected'])||!['target','control'].includes(c.kind)||typeof c.input!=='string'||c.input.length>1024||inputs.has(c.input)||
        !(typeof c.expected==='boolean'||(typeof c.expected==='string'&&c.expected.length<=1024)))invalid();
      inputs.add(c.input);kinds.add(c.kind);
    }
    if(kinds.size!==2)invalid();
    const snapshots=[];
    for(const p of [m.base,m.gold]){
      const f=await bounded(path.join(path.dirname(full),p.file),sourceLimit);
      if(same(f.stat,manifest.stat)||snapshots.some(other=>same(f.stat,other.stat))||sha(f.bytes)!==p.sha256)invalid();
      snapshots.push(f);
    }
    return {task:m.task,entry:m.entry,baseSource:snapshots[0].text,goldSource:snapshots[1].text,checks:m.checks,
      caseSha256:sha(JSON.stringify([m.schema,sha(manifest.bytes),m.base.sha256,m.gold.sha256]))};
  }catch{invalid();}
}
