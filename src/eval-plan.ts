import { createHash } from 'node:crypto';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
type Task = { id: string; caseSha256: string };
export type PlanInput = {
  models: string[]; tasks: Task[]; repeats: number; provider: string; routingGroup: string;
  systemPrompt: string; harnessRevision: string; tools: string[]; timeLimitSec: number;
  maxIterations: number; maxCostMicros: number; maxOutputTokens: number; temperature: number; seed: string;
};
const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function ids(list: unknown): list is string[] {
  return Array.isArray(list) && list.every(s => typeof s === 'string' && safeId.test(s)) && new Set(list).size === list.length;
}
export function makeEvaluationPlan(input: PlanInput) {
  if (!input || !ids(input.models) || input.models.length < 2 || input.models.length > 12 || !ids(input.tools) ||
      ![input.provider, input.routingGroup, input.seed].every(s => typeof s === 'string' && safeId.test(s)) ||
      typeof input.harnessRevision !== 'string' || !/^[a-f0-9]{40}$/.test(input.harnessRevision) ||
      typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim() || !positive(input.repeats) || input.repeats < 2 || input.repeats > 10 ||
      !positive(input.maxOutputTokens) || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2 || !positive(input.timeLimitSec) || !positive(input.maxIterations) || !positive(input.maxCostMicros) ||
      !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 200 || !ids(input.tasks.map(t => t?.id)) ||
      input.tasks.some(t => typeof t.caseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(t.caseSha256))) throw new Error('Invalid evaluation manifest: check model IDs, unique tasks, pinned digests, repeat count and limits.');
  const allowed = new Set(['models','tasks','repeats','provider','routingGroup','systemPrompt','harnessRevision','tools','timeLimitSec','maxIterations','maxCostMicros','maxOutputTokens','temperature','seed']);
  if (Object.keys(input).some(k => !allowed.has(k)) || input.tasks.some(t => Object.keys(t).some(k => !['id','caseSha256'].includes(k)))) throw new Error('Unsupported manifest field. Per-model overrides are not allowed.');
  const policy = { provider: input.provider, routingGroup: input.routingGroup, promptSha256: digest(input.systemPrompt), harnessRevision: input.harnessRevision,
    tools: [...input.tools].sort(), maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, timeLimitSec: input.timeLimitSec, maxIterations: input.maxIterations, maxCostMicros: input.maxCostMicros };
  const models = [...input.models].sort();
  const attempts = input.tasks.flatMap(task => Array.from({length: input.repeats}, (_, i) => {
    const repeat = i + 1;
    // Move the starting model on each repeat, inside a task/repeat block. No time-of-day-sized model batches.
    const offset = (parseInt(digest(JSON.stringify([input.seed,task.id])).slice(0,8),16) + i) % models.length;
    return models.map((_, j) => ({ task: task.id, caseSha256: task.caseSha256, repeat, model: models[(offset+j)%models.length] }));
  }).flat());
  const ceilingMicros = policy.maxCostMicros * attempts.length;
  if (!Number.isSafeInteger(ceilingMicros)) throw new Error('Budget ceiling exceeds exact integer range.');
  const body = { schema: 'jevio-eval-plan/v1', seed: input.seed, policy, ceilingMicros, attempts };
  return { ...body, planSha256: digest(JSON.stringify(body)) };
}
