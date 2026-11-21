import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

// Keep the original HTTP request, upload, receipt parsing, raw-content comparison and
// conditional polling. Other Cognee capabilities and Node imports are outside this task.
function project(full) {
  const slice=(first,next)=>{
    const start=full.indexOf(first), end=full.indexOf(next,start+first.length);
    if(start<0||end<0||full.indexOf(first,start+first.length)>=0)throw Error('Unknown historical receipt layout');
    return full.slice(start,end);
  };
  return slice('type Fetcher =','function responseItems(')+
    slice(full.includes('function dataRecords(')?'function dataRecords(':'function delay(', '  async status():')+
    slice('  async remember(content:', '  async forgetData(')+'}\n';
}
const current='Receipt row with content 42', stale='Previous upload 17';
const hashes=Object.fromEntries([current,stale].map(text=>[text,createHash('sha256').update(text).digest('hex')]));
const adapter=String.raw`(() => {
  const quote=JSON.stringify, hashes=${JSON.stringify(hashes)};
  const add=(k,v)=>Object.defineProperty(globalThis,k,{value:v});
  // A finite double of Node's SHA interface for the declared test strings. The actual
  // matching and choice of hash/field live in the provider, not the double.
  add('createHash',alg=>{if(alg!=='sha256')throw Error('unexpected hash');return {update(text){return {digest(enc){if(enc!=='hex'||typeof text!=='string'||!Object.hasOwn(hashes,text))throw Error('unknown hash operand');return hashes[text]}}}}});
  add('Headers',class{}); add('AbortSignal',{timeout:()=>undefined});
  const blobs=new WeakMap(), forms=new WeakMap();
  add('Blob',class {constructor(parts){if(parts.length===1&&typeof parts[0]==='string')blobs.set(this,parts[0])}});
  add('FormData',class {constructor(){forms.set(this,{})} append(k,v,n){const f=forms.get(this);if(k==='data'){f.text=blobs.get(v);f.name=n}else if(k==='datasetName'||k==='run_in_background')f[k]=v}});
  return async(Client,mode)=>{
    const origin='https://receipt.invalid',base='/api/v1/datasets/ds-r/data';
    let count=0,trace='',upload='',invalid=false;
    const http=async(url,init)=>{
      if(++count>6||typeof url!=='string'||url.length>256) {invalid=true;throw Error('request limit');}
      const method=init?.method??'GET'; if(typeof method!=='string'||method.length>16){invalid=true;throw Error('bad method')}
      trace+=(count===1?'':',')+'['+quote(method)+','+quote(url)+']';
      let body;
      if(method==='POST'&&url===origin+'/api/v1/remember'){
        const f=forms.get(init.body);
        if(!f||[f.name,f.text,f.datasetName,f.run_in_background].some(x=>typeof x!=='string'||x.length>128)){invalid=true;throw Error('bad upload')}
        upload='['+quote(f.name)+','+quote(f.text)+','+quote(f.datasetName)+','+quote(f.run_in_background)+']';
        body=mode==='direct'?' {"dataset_id":"ds-r","data_id":"already-addressed"}':' {"dataset_id":"ds-r"}';
      } else if(method==='GET'&&url===origin+base){body='[{"id":"other","name":"unrelated"},{"id":"stale","name":"note","created_at":"2026-07-03"},{"id":"match","name":"note","created_at":"2026-07-01"}]';}
      else if(method==='GET'&&url===origin+base+'/stale/raw') body=${JSON.stringify(stale)};
      else if(method==='GET'&&url===origin+base+'/match/raw') body=${JSON.stringify(current)};
      else {invalid=true;throw Error('unexpected route')}
      return {ok:true,status:200,text:async()=>body};
    };
    const client=new Client({enabled:true,baseUrl:origin,dataset:'local-scope',timeoutMs:1000,maxRememberCharacters:400},'.',http);
    let receipt;try{receipt=await client.remember(${JSON.stringify(current)},undefined,'note.md')}catch{return null}
    if(invalid||!upload||!receipt)return null;
    const data=receipt.dataId??null, ds=receipt.datasetId, hash=receipt.contentHash;
    if((data!==null&&(typeof data!=='string'||data.length>128))||typeof ds!=='string'||ds.length>128||typeof hash!=='string'||hash.length>128)return null;
    return '[['+trace+'],'+upload+','+quote(ds)+','+quote(data)+','+quote(hash)+']';
  };
})()`;
const origin='https://receipt.invalid',base=origin+'/api/v1/datasets/ds-r/data';
function expected(direct) {
  const requests=[['POST',origin+'/api/v1/remember']];
  if(!direct) requests.push(['GET',base],['GET',base+'/stale/raw'],['GET',base+'/match/raw']);
  return [requests,['note.md',current,'local-scope','true'],'ds-r',direct?'already-addressed':'match',hashes[current]];
}
export default {id:'cognee-data-receipt',path:'src/receipt-memory.ts',project,wrap:s=>s,entry:'CogneeMemory',adapter,
  checks:[['target','lookup',expected(false)],['control','direct',expected(true)]],
  judge(observed,want){if(typeof observed!=='string'||observed.length>4096)return 'INVALID';try{return isDeepStrictEqual(JSON.parse(observed),want)?'PASS':'FAIL'}catch{return 'INVALID'}}};
