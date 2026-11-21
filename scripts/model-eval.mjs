import { applyReview } from '../src/eval-review.ts';
import { reconcileBilling } from '../src/eval-billing.ts';
import { readFile } from 'node:fs/promises';
import { makeEvaluationPlan } from '../src/eval-plan.ts';
import { formatEvaluation } from '../src/eval-report.ts';

// Offline planning and reporting only. No provider credentials, agent tools or patch execution.
const help = `npm run eval -- plan MANIFEST.json
npm run eval -- report MANIFEST.json LEDGER.json
node scripts/model-eval.mjs reconcile MANIFEST.json LEDGER.json RECEIPTS.json
node scripts/model-eval.mjs review MANIFEST.json LEDGER.json DECISIONS.json
npm run eval:qualify   # trusted local control fixture; not a model run`;
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function main([cmd, file, ledger, ...extra]) {
  if (cmd === '--help' || cmd === undefined) { console.log(help); return; }
  if (!file || !((cmd === 'plan' && !ledger) || (cmd === 'report' && ledger && !extra.length) || (['review','reconcile'].includes(cmd) && ledger && extra.length === 1))) throw Error(help);
  const plan = makeEvaluationPlan(await json(file));
  if (cmd === 'plan') { console.log(JSON.stringify(plan, null, 2)); return; }
  const data = await json(ledger);
  if (data.schema !== 'jevio-eval-ledger/v1' || data.planSha256 !== plan.planSha256 || !['simulation','operator-import'].includes(data.source) || data.currency !== 'USD' || !Array.isArray(data.rows)) throw Error('Ledger schema, source, currency or plan digest mismatch.');
  const key = r => JSON.stringify([r.model, r.task, r.repeat]);
  const expected = new Set(plan.attempts.map(key));
  for (const row of data.rows) if (!expected.delete(key(row))) throw Error('Duplicate or unplanned attempt.');
  if (expected.size) throw Error('Incomplete ledger; not a comparable run.');
  if (cmd === 'review') { console.log(JSON.stringify(applyReview(data, await json(extra[0])),null,2)); return; }
  if (cmd === 'reconcile') {
    formatEvaluation(data.rows); // same input validation as report before billing changes
    const reconciled = reconcileBilling(data, await json(extra[0]));
    formatEvaluation(reconciled.rows);
    console.log(JSON.stringify(reconciled, null, 2)); return;
  }
  console.log(`Source: ${data.source === 'simulation' ? 'SIMULATED — not model results' : 'operator-imported — not independently attested'}. Currency: USD. Plan: ${plan.planSha256}\n\n${formatEvaluation(data.rows)}`);
}
main(process.argv.slice(2)).catch(e => { console.error(e instanceof SyntaxError ? 'Invalid JSON input.' : e.message); process.exitCode = 1; });
