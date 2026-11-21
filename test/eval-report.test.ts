import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEvaluation, summarizeEvaluation, type EvaluationRow } from '../src/eval-report.ts';

const row = (patch: Partial<EvaluationRow> = {}): EvaluationRow => ({model: 'm', task: 't', repeat: 1, verified: true, regression: false, accepted: true, costMicros: 30, durationMs: 5, ...patch});

test('cost includes failures; repeats are attempts, not distinct tasks', () => {
  const rows = [row({repeat: 2, costMicros: 10, accepted: false}), row(), row({task: 'other', verified: false, accepted: null, regression: true, costMicros: 80, durationMs: 2})];
  const [m] = summarizeEvaluation(rows);
  assert.deepEqual([m.attempts, m.verifiedAttempts, m.resolvedTasks, m.distinctTasks, m.acceptedTasks], [3,2,1,2,1]);
  assert.deepEqual([m.totalCostMicros,m.costPerVerifiedMicros,m.costPerAcceptedMicros], [120,60,120]);
  assert.deepEqual([m.regressions,m.reviewedAttempts,m.reviewedVerifiedAttempts,m.totalDurationMs,m.meanDurationMs], [1,2,2,12,4]);
  assert.deepEqual(m.tasks[1].repeats.map(r => r.repeat), [1,2]);
  assert.equal(rows[0].repeat, 2);
});

test('unknown costs, zero cost, absent denominators and pending reviews are distinguishable', () => {
  const [missing] = summarizeEvaluation([row(),row({repeat: 2, costMicros: null})]);
  assert.deepEqual([missing.knownCostAttempts, missing.totalCostMicros,missing.costPerVerifiedMicros,missing.costPerAcceptedMicros], [1,null,null,null]);
  assert.equal(summarizeEvaluation([row({costMicros:0})])[0].costPerAcceptedMicros,0);
  const [failed] = summarizeEvaluation([row({verified:false,accepted:false})]);
  assert.equal(failed.costPerVerifiedMicros,null); assert.equal(failed.costPerAcceptedMicros,null);
  assert.equal(summarizeEvaluation([row(),row({repeat: 2, accepted:null})])[0].costPerAcceptedMicros,null);
});

test('rejects malformed or contradictory rows without coercion', () => {
  for (const patch of [{repeat:0},{repeat:-1},{repeat:1.1},{repeat:'1'},{repeat:Infinity},{model:''},{task:'   '},{task:'a\nb'},{verified:1},{regression:null},{accepted:'false'},{accepted:undefined},{costMicros:undefined},{costMicros:-1},{costMicros:1.5},{durationMs:NaN},{durationMs:-1},{durationMs:'5'},{durationMs:Infinity},{verified:false},{regression:true}]) {
    assert.throws(() => summarizeEvaluation([row(patch as Partial<EvaluationRow>)]));
  }
  for (const value of [null,{},[],[null]]) assert.throws(() => summarizeEvaluation(value as EvaluationRow[]));
  assert.throws(() => summarizeEvaluation([row({costMicros:Number.MAX_SAFE_INTEGER}),row({repeat:2})]), /range/);
});

test('regressions exclude unassessed attempts; zero requires an assessment', () => {
  const unknown = row({ verified: false, accepted: null, regression: null });
  for (const [rows, counts, cells] of [
    [[unknown], [null, 0, 1], '—/0 | 1'],
    [[unknown, row({ repeat: 2 })], [0, 1, 1], '0/1 | 1'],
    [[unknown, row({ repeat: 2 }), row({ repeat: 3, verified: false, accepted: false, regression: true })], [1, 2, 1], '1/2 | 1'],
  ] as const) {
    const [m] = summarizeEvaluation(rows);
    assert.deepEqual([m.regressions, m.regressionAssessedAttempts, m.regressionUnknownAttempts], counts);
    const report = formatEvaluation(rows);
    assert.ok(report.includes(`| ${cells} |`));
    assert.match(report, /#1: regression unassessed/);
  }
  assert.throws(() => summarizeEvaluation([row({ regression: null, accepted: null })]), /Verification/);
  for (const invalid of [undefined, 0, 'false']) {
    assert.throws(() => summarizeEvaluation([{ ...unknown, regression: invalid } as EvaluationRow]), /flags/);
  }
});

test('Markdown tables have consistent header, separator, and data column counts', () => {
  const blocks = formatEvaluation([row()]).split('\n\n').filter(b => b.startsWith('|'));
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const [header, separator, ...rows] = block.trimEnd().split('\n');
    assert.match(separator, /^\|(?:---:?\|)+$/);
    for (const line of [separator, ...rows]) assert.equal(line.split('|').length, header.split('|').length);
  }
});

test('requires unique identical task/repeat cells, not just identical counts', () => {
  assert.throws(() => summarizeEvaluation([row(), row()]), /Duplicate/);
  for (const extra of [{task:'different'}, {repeat:2}]) assert.throws(() => summarizeEvaluation([row(),row({model:'other',...extra})]), /matrices/);
  const rows = [row(),row({task:'__proto__',repeat:3}),row({model:'other'}),row({model:'other',task:'__proto__',repeat:3})];
  assert.deepEqual(summarizeEvaluation(rows), summarizeEvaluation(rows.toReversed()));
});

test('Markdown shows labelled units, repeat outcomes, pending reviews, and escapes labels', () => {
  const report = formatEvaluation([row({model:'x|y',task:'<script>',accepted:null})]);
  assert.match(report,/ms\/attempt/); assert.match(report,/millionths/); assert.match(report,/#1: verified, unreviewed/);
  assert.doesNotMatch(report,/<script>|x\|y|winner|simulated/i);
});
