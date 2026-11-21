import type { EvaluationRow } from './eval-report.ts';

type BillingRow = EvaluationRow & { requestId: string | null };
type Ledger = { schema: 'jevio-eval-ledger/v1'; planSha256: string; source: 'simulation' | 'operator-import'; currency: 'USD'; rows: readonly BillingRow[] };
type Receipt = { requestId: string; model: string; currency: 'USD'; costMicros: number | null };

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
}
function validCost(value: number | null) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

/** Join an operator-scoped export, not proof of billing authenticity. Status never determines cost. */
export function reconcileBilling<L extends Ledger>(ledger: L, receipts: readonly Receipt[]) {
  if (ledger?.schema !== 'jevio-eval-ledger/v1' || ledger.currency !== 'USD' ||
      !['simulation', 'operator-import'].includes(ledger.source) || typeof ledger.planSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ledger.planSha256) || !Array.isArray(ledger.rows) || !Array.isArray(receipts)) {
    throw new Error('Invalid ledger or receipt export');
  }
  const byId = new Map<string, BillingRow>();
  const attempts = new Set<string>();
  for (const row of ledger.rows) {
    if (!row || !identifier(row.model) || !identifier(row.task) || !Number.isSafeInteger(row.repeat) || row.repeat < 1 ||
        !validCost(row.costMicros) || (row.requestId !== null && !identifier(row.requestId))) throw new Error('Invalid billing row');
    const key = JSON.stringify([row.model, row.task, row.repeat]);
    if (attempts.has(key)) throw new Error('Duplicate attempt');
    attempts.add(key);
    if (row.requestId === null) continue;
    if (byId.has(row.requestId)) throw new Error('Duplicate ledger request ID');
    byId.set(row.requestId, row);
  }
  const costs = new Map<string, number | null>();
  for (const receipt of receipts) {
    if (!receipt || !identifier(receipt.requestId) || !identifier(receipt.model) || receipt.currency !== 'USD' || !validCost(receipt.costMicros)) throw new Error('Invalid receipt');
    if (costs.has(receipt.requestId)) throw new Error('Duplicate receipt request ID');
    const row = byId.get(receipt.requestId);
    if (!row) throw new Error('Receipt outside ledger scope');
    if (row.model !== receipt.model) throw new Error('Receipt model mismatch');
    if (row.costMicros !== null && receipt.costMicros !== null && row.costMicros !== receipt.costMicros) throw new Error('Conflicting known costs');
    costs.set(receipt.requestId, receipt.costMicros);
  }
  return { ...ledger, rows: ledger.rows.map(row => ({ ...row, costMicros: row.costMicros ?? (row.requestId === null ? null : costs.get(row.requestId) ?? null) })) };
}
