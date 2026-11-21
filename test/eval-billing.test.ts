import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBilling } from '../src/eval-billing.ts';
import { summarizeEvaluation } from '../src/eval-report.ts';

const row = (repeat: number, requestId: string | null, costMicros: number | null = null) => ({
  model: 'model/v1', task: 'example', repeat, status: repeat === 1 ? 'ok' : 'failed',
  requestId, costMicros, durationMs: 5, verified: repeat === 1, regression: repeat === 1 ? false : null, accepted: null,
});
const ledger = (...rows: ReturnType<typeof row>[]) => ({schema: 'jevio-eval-ledger/v1' as const, source: 'operator-import' as const, currency: 'USD' as const, planSha256: 'c'.repeat(64), rows});
const receipt = (requestId: string, costMicros: number | null) => ({requestId, model: 'model/v1', currency: 'USD' as const, costMicros});

test('joins by ID, charges failures, preserves source, statuses and inputs; replay is idempotent', () => {
  for (const source of ['simulation', 'operator-import'] as const) {
    const input = {...ledger(row(1,'a'),row(2,'b')),source};
    const bills = [receipt('b',1200), receipt('a',0)];
    const before = structuredClone({input,bills});
    const out = reconcileBilling(input,bills);
    assert.deepEqual(out,{...input,rows:[row(1,'a',0),row(2,'b',1200)]});
    assert.equal(summarizeEvaluation(out.rows)[0].costPerVerifiedMicros,1200);
    assert.deepEqual(reconcileBilling(out,bills),out);
    assert.deepEqual({input,bills},before);
  }
});

test('no receipt or request ID is not a free attempt; null receipts do not erase known costs', () => {
  const input = ledger(row(1,null),row(2,null),row(3,'no-receipt'),row(4,'pending'),row(5,'known',400));
  const out = reconcileBilling(input,[receipt('pending',null),receipt('known',null)]);
  assert.deepEqual(out,input);
  assert.equal(summarizeEvaluation(out.rows)[0].totalCostMicros,null);
});

test('rejects duplicate IDs and duplicate attempt coordinates, including unbilled attempts', () => {
  assert.throws(()=>reconcileBilling(ledger(row(1,'a'),row(2,'a')),[]),/Duplicate ledger request ID/);
  assert.throws(()=>reconcileBilling(ledger(row(1,'a'),row(1,'b')),[]),/Duplicate attempt/);
  assert.throws(()=>reconcileBilling(ledger(row(1,'a')),[receipt('a',null),receipt('a',0)]),/Duplicate receipt/);
});

test('rejects unrelated receipts, wrong models, currencies and known-cost overwrites atomically', () => {
  const input=ledger(row(1,'a'),row(2,'b',0));
  const before=structuredClone(input);
  for (const bad of [receipt('B',2),receipt('b',1),{...receipt('b',0),model:'Model/v1'}, {...receipt('b',0),currency:'EUR' as 'USD'}]) {
    assert.throws(()=>reconcileBilling(input,[receipt('a',5),bad]));
    assert.deepEqual(input,before);
  }
});

test('rejects ambiguous IDs, invalid units, and invalid ledger identity', () => {
  for (const n of [-1,1.4,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>reconcileBilling(ledger(row(1,'x',n)),[]));
    assert.throws(()=>reconcileBilling(ledger(row(1,'x')),[receipt('x',n)]));
  }
  assert.throws(()=>reconcileBilling(ledger(row(1,'   ')),[]));
  assert.throws(()=>reconcileBilling(ledger(row(1,'x')),[receipt('',0)]));
  assert.throws(()=>reconcileBilling({...ledger(),planSha256:'invalid'},[]));
});
