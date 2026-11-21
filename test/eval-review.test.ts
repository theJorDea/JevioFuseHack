import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/eval-plan.ts';
import {applyReview,reviewArtifacts} from '../src/eval-review.ts';
import {summarizeEvaluation} from '../src/eval-report.ts';
const source='// example'; const candidateSha256=digest(source); const planSha256=digest('plan');
const row={model:'private-model',task:'one',repeat:1,verified:true,regression:false,accepted:null,costMicros:20,durationMs:6,candidateSha256};
const ledger={schema:'jevio-eval-ledger/v1',source:'simulation',currency:'USD',planSha256,rows:[row,{...row,repeat:2}]};
const decisions=[{task:'one',candidateSha256,accepted:true}];
test('review hides routing and cost, deduplicates byte-identical fixes within task, never auto-accepts',()=>{
  assert.deepEqual(reviewArtifacts(ledger,new Map([[candidateSha256,source]])),{planSha256,items:[{task:'one',candidateSha256,source}]});
  assert.throws(()=>reviewArtifacts(ledger,new Map([[candidateSha256,'other']])));
  const reviewed=applyReview(ledger,{planSha256,decisions});assert.ok(reviewed.rows.every(r=>r.accepted));
  assert.ok(ledger.rows.every(r=>r.accepted===null));assert.equal(summarizeEvaluation(reviewed.rows)[0].costPerAcceptedMicros,20);
  assert.throws(()=>applyReview(reviewed,{planSha256,decisions:[{...decisions[0],accepted:false}]}));
});
test('rejects wrong plans, duplicate decisions, missing digests, and unverified fixes',()=>{
  assert.throws(()=>applyReview(ledger,{planSha256:digest('wrong'),decisions}));
  assert.throws(()=>applyReview(ledger,{planSha256,decisions:[...decisions,...decisions]}));
  assert.throws(()=>applyReview({...ledger,rows:[{...row,verified:false}]},{planSha256,decisions}));
  assert.throws(()=>applyReview(ledger,{planSha256,decisions:[{...decisions[0],candidateSha256:digest('wrong')}]}));
});
