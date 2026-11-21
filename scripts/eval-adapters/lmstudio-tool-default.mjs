// Project the actual provider-merge expressions from the pinned config.ts. No disk/config loader or Node imports in the candidate packet.
const path = 'src/merge-providers.ts';
function project(fullSource, edition) {
  const take = (start, end) => {
    const a = fullSource.indexOf(start), b = fullSource.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw Error('Provider merge fixture no longer matches the documented slice');
    return fullSource.slice(a, b);
  };
  const defaults = take('  providers: {', '\n  roles:');
  let body;
  if (edition === 'base') {
    const field = take('    providers: { ...DEFAULT_CONFIG.providers, ...input.providers }', ',\n    roles,');
    body = `  return ${field.slice('    providers: '.length)};`;
  } else if (edition === 'gold') {
    body = take('  for (const [name, provider] of Object.entries(input.providers ?? {})) {', '\n  return {\n    defaultProvider:') + '\n  return providers;';
  } else throw Error('Unknown provider merge fixture edition');
  return `type ProviderConfig = {baseUrl:string; toolMode?: 'auto'|'native'|'text'; apiKey?:string; apiKeyEnv?:string; transport?:'chat_completions'|'responses'; headers?:Record<string,string>};\nconst DEFAULT_CONFIG = {\n${defaults}\n};\nexport function mergeProviders(input:{providers?:Record<string,ProviderConfig>}) {\n${body}\n}\n`;
}

// Capture guest intrinsics before candidate initialization. Return observable fields, never a verdict supplied by candidate code.
const adapter = `((parse) => async (fn,input) => {
  const rows = parse(input), providers = {};
  for (let i=0;i<rows.length;i++) { const [name,config]=rows[i]; providers[name]=config; }
  const resolved = fn({providers}); let wire='';
  for (let i=-1;i<rows.length;i++) {
    const p = resolved?.[i<0?'ollama':rows[i][0]], url=p?.baseUrl, mode=p?.toolMode;
    if (typeof url!=='string' || url.length>128 || (mode!==undefined && (typeof mode!=='string'||mode.length>16))) return null;
    const fields=[url,mode,p.apiKey,p.apiKeyEnv,p.transport,p.headers?.['x-eval-route'],p.headers?.['x-eval-format']];
    for(let j=0;j<fields.length;j++) {
      const v=fields[j]; if(v!==undefined && (typeof v!=='string'||v.length>128))return null;
      wire+=v===undefined?'-':v.length+':'+v;
    }
    wire+=';';
  }
  return wire;
})(JSON.parse)`;
const local='http://127.0.0.1:1234/v1';
function check(kind, rows){
  // All config values are inert fixture markers; no environment or credential lookup.
  const inputs=rows.map(([name,baseUrl,mode],i)=>[name,{baseUrl,...(mode===null?{}:{toolMode:mode}),
    apiKey:`fixture-key-${i}`,apiKeyEnv:`EVAL_UNUSED_${i}`,transport:i%2?'chat_completions':'responses',
    headers:{'x-eval-route':name,'x-eval-format':`format-${i}`}}]);
  const expected=[['http://localhost:11434/v1',null,null,null,null,null,null],...inputs.map(([,p],i)=>
    [p.baseUrl,rows[i][3],p.apiKey,p.apiKeyEnv,p.transport,p.headers['x-eval-route'],p.headers['x-eval-format']])];
  return [kind,JSON.stringify(inputs),expected.map(fields=>fields.map(v=>v===null?'-':`${v.length}:${v}`).join('')+';').join('')];
}
const checks = [
  check('target', [['aliased',local,null,'text'],['second','http://localhost:1234',null,'text'],['LmStudio','https://proxy.invalid/v1',null,'text']]),
  check('control', [['explicit-native',local,'native','native'],['explicit-auto',local,'auto','auto'],['other-text','https://example.invalid/v1','text','text'],['remote','http://provider.invalid:1234/v1',null,null],['near','http://localhost:12345/v1',null,null]]),
];
export default {id:'lmstudio-tool-default',path,project,wrap:source=>source,entry:'mergeProviders',adapter,checks,
  judge:(observed,expected)=>typeof observed!=='string'?'INVALID':observed===expected?'PASS':'FAIL'};
