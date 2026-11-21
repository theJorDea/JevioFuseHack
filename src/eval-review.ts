// Review decisions are supplied by a human, never by a testcase. No IO or edits in place.
import { createHash } from 'node:crypto';
import { summarizeEvaluation, type EvaluationRow } from './eval-report.ts';

type Row = EvaluationRow & {candidateSha256?:string};
type Ledger = {schema:string;planSha256:string;source:string;currency:string;rows:Row[]};
type Decision = {task:string;candidateSha256:string;accepted:boolean};
const hex = (v:unknown) => typeof v==='string' && /^[0-9a-f]{64}$/.test(v);
const key = (task:string, hash:string) => JSON.stringify([task,hash]);
export function applyReview(ledger:Ledger, review:{planSha256:string;decisions:Decision[]}) {
  if(ledger.schema!=='jevio-eval-ledger/v1'||!hex(ledger.planSha256)||ledger.planSha256!==review?.planSha256 || !Array.isArray(review.decisions)) throw Error('Review does not match this plan');
  summarizeEvaluation(ledger.rows);
  const eligible=new Set(ledger.rows.filter(r=>r.verified&&hex(r.candidateSha256)).map(r=>key(r.task,r.candidateSha256!)));
  const votes=new Map<string,boolean>();
  for(const d of review.decisions){
    if(!d||!hex(d.candidateSha256)||typeof d.accepted!=='boolean') throw Error('Invalid human decision');
    const k=key(d.task,d.candidateSha256);
    if(!eligible.has(k)||votes.has(k))throw Error('Duplicate or unknown verified artifact');
    votes.set(k,d.accepted);
  }
  return {...ledger,rows:ledger.rows.map(row=>{
    const vote=row.verified && row.candidateSha256 ? votes.get(key(row.task,row.candidateSha256)):undefined;
    if(vote!==undefined&&row.accepted!==null&&row.accepted!==vote)throw Error('Review conflicts with prior decision');
    return {...row,accepted:vote??row.accepted};
  })};
}
// Deliberately excludes model, timing, price and attempt counts. Source stays local to the reviewer.
export function reviewArtifacts(ledger:Ledger, artifacts:Map<string,string>){
  const items=new Map<string,{task:string;candidateSha256:string;source:string}>();
  for(const r of ledger.rows){
    if(!r.verified)continue;
    if(!hex(r.candidateSha256))throw Error('Missing verified artifact digest');
    const hash=r.candidateSha256!, source=artifacts.get(hash);
    if(source===undefined||createHash('sha256').update(source).digest('hex')!==hash)throw Error('Missing or mismatched local artifact');
    items.set(key(r.task,hash),{task:r.task,candidateSha256:hash,source});
  }
  return {planSha256:ledger.planSha256,items:[...items.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,item])=>item)};
}
