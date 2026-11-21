export interface EvaluationRow {
  model: string;
  task: string;
  repeat: number;
  verified: boolean;
  regression: boolean | null;
  accepted: boolean | null;
  costMicros: number | null;
  durationMs: number;
}

function validate(r: EvaluationRow) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new TypeError('Expected an evaluation row');
  for (const key of ['model', 'task'] as const) {
    if (typeof r[key] !== 'string' || !r[key].trim() || /[\x00-\x1f\x7f]/u.test(r[key])) throw new TypeError(`Invalid ${key}`);
  }
  if (!Number.isSafeInteger(r.repeat) || r.repeat < 1) throw new TypeError('Invalid repeat');
  if (typeof r.verified !== 'boolean' || (r.regression !== null && typeof r.regression !== 'boolean')) throw new TypeError('Invalid verification flags');
  if (r.accepted !== null && typeof r.accepted !== 'boolean') throw new TypeError('Invalid accepted');
  if (r.accepted && !r.verified) throw new Error('Acceptance requires verification');
  if (r.verified && r.regression !== false) throw new Error('Verification requires an assessed, regression-free attempt');
  if (r.costMicros !== null && (!Number.isSafeInteger(r.costMicros) || r.costMicros < 0)) throw new TypeError('Invalid costMicros');
  if (!Number.isFinite(r.durationMs) || r.durationMs < 0) throw new TypeError('Invalid durationMs');
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A task is resolved if at least one repeat verified. Repeat indices need not be contiguous. */
export function summarizeEvaluation(rows: readonly EvaluationRow[]) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Expected a non-empty evaluation');
  const groups = new Map<string, Map<string, EvaluationRow[]>>();
  const seen = new Set<string>();
  for (const row of rows) {
    validate(row);
    const key = JSON.stringify([row.model, row.task, row.repeat]);
    if (seen.has(key)) throw new Error('Duplicate model/task/repeat');
    seen.add(key);
    if (!groups.has(row.model)) groups.set(row.model, new Map());
    const tasks = groups.get(row.model)!;
    if (!tasks.has(row.task)) tasks.set(row.task, []);
    tasks.get(row.task)!.push(row);
  }
  let matrix: string | undefined;
  return [...groups.keys()].sort(compare).map(model => {
    const grouped = groups.get(model)!;
    const tasks = [...grouped.keys()].sort(compare).map(task => {
      const repeats = grouped.get(task)!.sort((a, b) => a.repeat - b.repeat)
        .map(({model: _model, task: _task, ...attempt}) => attempt);
      return { task, repeats, verifiedAttempts: repeats.filter(r => r.verified).length, acceptedAttempts: repeats.filter(r => r.accepted).length };
    });
    const signature = JSON.stringify(tasks.map(t => [t.task, t.repeats.map(r => r.repeat)]));
    if (matrix !== undefined && matrix !== signature) throw new Error('Models must have identical task/repeat matrices');
    matrix = signature;
    const attempts = tasks.flatMap(t => t.repeats);
    const verifiedAttempts = attempts.filter(r => r.verified).length;
    const acceptedAttempts = attempts.filter(r => r.accepted === true).length;
    const reviewedAttempts = attempts.filter(r => r.accepted !== null).length;
    const reviewedVerifiedAttempts = attempts.filter(r => r.verified && r.accepted !== null).length;
    const regressionAssessedAttempts = attempts.filter(r => r.regression !== null).length;
    const regressionUnknownAttempts = attempts.length - regressionAssessedAttempts;
    const regressions = regressionAssessedAttempts ? attempts.filter(r => r.regression === true).length : null;
    const knownCostAttempts = attempts.filter(r => r.costMicros !== null).length;
    const totalCostMicros = knownCostAttempts === attempts.length ? attempts.reduce((s,r) => s + r.costMicros!, 0) : null;
    const totalDurationMs = attempts.reduce((s,r) => s + r.durationMs, 0);
    if ((totalCostMicros !== null && !Number.isSafeInteger(totalCostMicros)) || !Number.isFinite(totalDurationMs)) throw new RangeError('Aggregate exceeds numeric range');
    return { model, tasks, attempts: attempts.length, distinctTasks: tasks.length, verifiedAttempts, acceptedAttempts,
      resolvedTasks: tasks.filter(t => t.verifiedAttempts > 0).length, acceptedTasks: tasks.filter(t => t.acceptedAttempts > 0).length,
      reviewedAttempts, reviewedVerifiedAttempts, regressions, regressionAssessedAttempts, regressionUnknownAttempts, knownCostAttempts, totalCostMicros,
      costPerVerifiedMicros: totalCostMicros !== null && verifiedAttempts ? totalCostMicros / verifiedAttempts : null,
      costPerAcceptedMicros: totalCostMicros !== null && acceptedAttempts && reviewedVerifiedAttempts === verifiedAttempts ? totalCostMicros / acceptedAttempts : null,
      totalDurationMs, meanDurationMs: totalDurationMs / attempts.length };
  });
}

function cell(text: string) {
  return text.replace(/[^\p{L}\p{N} -]/gu, c => `&#${c.codePointAt(0)};`);
}
const quantity = (n: number | null) => n === null ? '—' : Number(n.toFixed(3)).toString();

export function formatEvaluation(rows: readonly EvaluationRow[]): string {
  const models = summarizeEvaluation(rows);
  const columns = ['Model', 'Verified / attempts', 'Resolved / tasks', 'Accepted / attempts', 'Accepted tasks', 'Reviewed / attempts', 'Reviewed / verified', 'Regressions / assessed', 'Regression unknown', 'Known costs / attempts', 'Total cost (µ)', 'Cost / verified (µ)', 'Cost / accepted (µ)', 'Total time (ms)', 'Mean (ms/attempt)'];
  return ['# Evaluation', '', `| ${columns.join(' | ')} |`,
    `|${columns.map((_, i) => i === 0 ? '---' : '---:').join('|')}|`,
    ...models.map(m => `| ${cell(m.model)} | ${m.verifiedAttempts}/${m.attempts} | ${m.resolvedTasks}/${m.distinctTasks} | ${m.acceptedAttempts}/${m.attempts} | ${m.acceptedTasks}/${m.distinctTasks} | ${m.reviewedAttempts}/${m.attempts} | ${m.reviewedVerifiedAttempts}/${m.verifiedAttempts} | ${quantity(m.regressions)}/${m.regressionAssessedAttempts} | ${m.regressionUnknownAttempts} | ${m.knownCostAttempts}/${m.attempts} | ${quantity(m.totalCostMicros)} | ${quantity(m.costPerVerifiedMicros)} | ${quantity(m.costPerAcceptedMicros)} | ${quantity(m.totalDurationMs)} | ${quantity(m.meanDurationMs)} |`),
    '', 'Costs are millionths (µ) of the common billing currency and include **all attempts**, including failures. — means unknown or undefined, never zero. Cost per accepted attempt is withheld until all verified attempts have a review. Durations sum attempt time, not concurrent wall time.',
    '', 'A resolved task has at least one verified repeat. Inspect repeat outcomes rather than treating them as independent tasks.', '', '| Model | Task | Repeat outcomes |', '|---|---|---|',
    ...models.flatMap(m => m.tasks.map(t => `| ${cell(m.model)} | ${cell(t.task)} | ${t.repeats.map(r => `#${r.repeat}: ${r.regression === null ? 'regression unassessed' : r.regression ? 'regression' : r.verified ? 'verified' : 'not verified'}, ${r.accepted === null ? 'unreviewed' : r.accepted ? 'accepted' : 'rejected'}`).join('; ')} |`)), ''].join('\n');
}
