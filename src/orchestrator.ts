import { runAgent, type AgentEvent } from "./agent.ts";
import type { AgentResult, ChatMessage, JevioConfig, ToolContext } from "./types.ts";

export interface TeamOptions {
  task: string;
  config: JevioConfig;
  toolContext: ToolContext;
  history?: ChatMessage[];
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
  approvePlan?: (plan: string) => Promise<{ decision: "approve" | "reject" | "revise"; feedback?: string }>;
  requireWorkspaceChange?: boolean;
  getWorkspaceMutationCount?: () => number;
}

function sanitizePlan(plan: string): string {
  return plan.replace(/\s*<verdict>(?:PASS|FIX)<\/verdict>\s*/giu, "\n").trim();
}

async function approvePlan(
  options: TeamOptions,
  runner: typeof runAgent,
  role: "architect" | "judge",
  initialPlan: string,
): Promise<{ plan: string; turns: number }> {
  if (!options.approvePlan) return { plan: sanitizePlan(initialPlan), turns: 0 };
  let plan = sanitizePlan(initialPlan);
  let turns = 0;
  for (let revision = 0; revision < 3; revision += 1) {
    const approval = await options.approvePlan(plan);
    if (approval.decision === "approve") return { plan, turns };
    if (approval.decision === "reject") throw new Error("План отклонен пользователем. Файлы не изменены.");
    const feedback = approval.feedback?.trim();
    if (!feedback) throw new Error("Для переработки плана нужен комментарий пользователя.");
    const revised = await runner({
      role,
      task: `Revise the implementation plan using the user's feedback. Keep valid constraints, inspect the repository when needed, and return only the complete updated plan.\n\nCURRENT PLAN:\n${plan}\n\nUSER FEEDBACK:\n${feedback}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      maxTurns: Math.min(10, options.config.agent.maxTurns),
      onEvent: options.onEvent,
    });
    plan = sanitizePlan(revised.content);
    turns += revised.turns;
  }
  throw new Error("План не был одобрен после трех итераций.");
}

async function implementWithRecovery(
  options: TeamOptions,
  runner: typeof runAgent,
  task: string,
): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; turns: number }> {
  const mutationsBefore = options.getWorkspaceMutationCount?.();
  let result = await runner({
    role: "coder",
    task,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    onEvent: options.onEvent,
  });
  let turns = result.turns;

  if (
    options.requireWorkspaceChange
    && mutationsBefore !== undefined
    && options.getWorkspaceMutationCount?.() === mutationsBefore
  ) {
    options.onEvent?.({
      type: "progress",
      role: "coder",
      detail: "Coder вернул текст без изменений. Повторяю запуск с обязательной записью файлов.",
    });
    result = await runner({
      role: "coder",
      task: `${task}\n\nThe previous coder response did not modify the workspace. Continue autonomously now: use native workspace tools. If this model cannot emit native tool calls, return ONLY this fallback JSON (no Markdown): {"jevio_tool_calls":[{"name":"write_file","arguments":{"path":"relative/path","content":"complete file content"}}]}. You may include multiple calls. Jevio will execute them with normal permissions, then you can verify the results.\n\nPREVIOUS CODER RESPONSE:\n${result.content}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      onEvent: options.onEvent,
    });
    turns += result.turns;
    if (options.getWorkspaceMutationCount?.() === mutationsBefore) {
      throw new Error("Coder дважды завершил работу, не изменив файлы проекта.");
    }
  }

  return { result, turns };
}

export interface TeamResult extends AgentResult {
  plan: string;
  review: string;
  fixesApplied: number;
}

export interface CouncilPlanResult extends TeamResult {
  architectPlans: string[];
  judgment: string;
}

export interface CouncilReviewResult extends AgentResult {
  reviews: string[];
  judgment: string;
  verdict: "PASS" | "FIX";
}

const COUNCIL_PLAN_PROMPTS = [
  "Propose a concrete implementation plan. Inspect the repository and identify exact files, interfaces, data flow, and verification.",
  "Independently propose the safest minimal implementation plan. Challenge likely assumptions, compare alternatives, and identify migration or compatibility risks.",
  "Act as a risk-focused architect. Inspect the repository and list failure modes, regressions, missing tests, and the plan that best contains those risks.",
];

const COUNCIL_REVIEW_PROMPTS = [
  "Review the current workspace changes with a security focus: trust boundaries, secrets, path handling, injection, permissions, and unsafe defaults.",
  "Review the current workspace changes with a correctness focus: behavioral regressions, edge cases, state handling, API contracts, and error paths.",
  "Review the current workspace changes with a test and maintainability focus: missing coverage, broken assumptions, fragile code, and verification gaps.",
];

function needsFix(review: string): boolean {
  return review.includes("<verdict>FIX</verdict>");
}

function labeledReports(name: string, reports: string[]): string {
  return reports.map((report, index) => `## ${name} ${index + 1}\n${report}`).join("\n\n");
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(items.length, Math.floor(limit) || 1)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      result[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return result;
}

async function reviewAndFix(
  options: TeamOptions,
  runner: typeof runAgent,
  implementation: Awaited<ReturnType<typeof runAgent>>,
): Promise<{ implementation: Awaited<ReturnType<typeof runAgent>>; review: string; fixesApplied: number; turns: number }> {
  let currentImplementation = implementation;
  let reviewResult = await runner({
    role: "reviewer",
    task: `Review the implementation for this request:\n\n${options.task}\n\nImplementation agent report:\n${currentImplementation.content}`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    maxTurns: Math.min(12, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });
  let turns = reviewResult.turns;
  let fixesApplied = 0;

  while (needsFix(reviewResult.content) && fixesApplied < options.config.agent.maxReviewFixes) {
    fixesApplied += 1;
    currentImplementation = await runner({
      role: "coder",
      task: `Fix the review findings that are valid, then rerun relevant checks.\n\nORIGINAL REQUEST:\n${options.task}\n\nREVIEW:\n${reviewResult.content}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      onEvent: options.onEvent,
    });
    turns += currentImplementation.turns;
    reviewResult = await runner({
      role: "reviewer",
      task: `Re-review the current workspace after fixes for this request:\n\n${options.task}\n\nFix report:\n${currentImplementation.content}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      maxTurns: Math.min(12, options.config.agent.maxTurns),
      onEvent: options.onEvent,
    });
    turns += reviewResult.turns;
  }

  return { implementation: currentImplementation, review: reviewResult.content, fixesApplied, turns };
}

export async function runTeam(options: TeamOptions): Promise<TeamResult> {
  const runner = options.runner ?? runAgent;
  const planResult = await runner({
    role: "architect",
    task: `Design a concrete implementation plan for this request:\n\n${options.task}`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    maxTurns: Math.min(10, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });
  const approved = await approvePlan(options, runner, "architect", planResult.content);
  const implemented = await implementWithRecovery(
    options,
    runner,
    `Implement the user's request. The architecture agent produced this approved plan; verify it against the repository and adjust it only when necessary.\n\nUSER REQUEST:\n${options.task}\n\nAPPROVED PLAN:\n${approved.plan}`,
  );
  const reviewed = await reviewAndFix(options, runner, implemented.result);

  return {
    content: reviewed.implementation.content,
    turns: planResult.turns + approved.turns + implemented.turns + reviewed.turns,
    plan: approved.plan,
    review: reviewed.review,
    fixesApplied: reviewed.fixesApplied,
  };
}

export async function runCouncilPlan(options: TeamOptions): Promise<CouncilPlanResult> {
  const runner = options.runner ?? runAgent;
  const architectResults = await mapWithConcurrency(
    COUNCIL_PLAN_PROMPTS,
    options.config.agent.maxParallelReadAgents,
    async (prompt) => runner({
      role: "architect",
      task: `${prompt}\n\nUSER REQUEST:\n${options.task}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      maxTurns: Math.min(10, options.config.agent.maxTurns),
      onEvent: options.onEvent,
    }),
  );
  const architectPlans = architectResults.map((result) => result.content);
  const judgeResult = await runner({
    role: "judge",
    task: `Choose and refine the best implementation plan for the user request. Treat the architect reports as advisory evidence, verify claims against the repository when useful, and produce one actionable plan for the coder.\n\nUSER REQUEST:\n${options.task}\n\n${labeledReports("ARCHITECT PROPOSAL", architectPlans)}`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    maxTurns: Math.min(10, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });
  const approved = await approvePlan(options, runner, "judge", judgeResult.content);
  const implemented = await implementWithRecovery(
    options,
    runner,
    `Implement the user's request using the approved council plan. Verify the plan against the repository, make focused edits, and run relevant checks.\n\nUSER REQUEST:\n${options.task}\n\nAPPROVED PLAN:\n${approved.plan}`,
  );
  const reviewed = await reviewAndFix(options, runner, implemented.result);

  return {
    content: reviewed.implementation.content,
    turns: architectResults.reduce((total, result) => total + result.turns, 0) + judgeResult.turns + approved.turns + implemented.turns + reviewed.turns,
    plan: approved.plan,
    review: reviewed.review,
    fixesApplied: reviewed.fixesApplied,
    architectPlans,
    judgment: approved.plan,
  };
}

export async function runCouncilReview(options: TeamOptions): Promise<CouncilReviewResult> {
  const runner = options.runner ?? runAgent;
  const reviewContext: ToolContext = {
    ...options.toolContext,
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  const reviewerResults = await mapWithConcurrency(
    COUNCIL_REVIEW_PROMPTS,
    options.config.agent.maxParallelReadAgents,
    async (prompt) => runner({
      role: "reviewer",
      task: `${prompt}\n\nReview scope:\n${options.task}\n\nInspect the actual workspace and git diff. End with a verdict marker.`,
      config: options.config,
      toolContext: reviewContext,
      history: options.history,
      maxTurns: Math.min(12, options.config.agent.maxTurns),
      onEvent: options.onEvent,
    }),
  );
  const reviews = reviewerResults.map((result) => result.content);
  const judgeResult = await runner({
    role: "judge",
    task: `Make the final council-review decision. Inspect the current workspace or diff when needed. Keep only findings that are concrete and actionable. Use this exact Markdown structure: \"## Critical\", \"## Warnings\", \"## Consensus\", \"## Disagreements\", \"## Recommended fixes\". Write \"None.\" for empty sections. End with exactly one verdict marker.\n\nREVIEW SCOPE:\n${options.task}\n\n${labeledReports("REVIEWER REPORT", reviews)}`,
    config: options.config,
    toolContext: reviewContext,
    history: options.history,
    maxTurns: Math.min(12, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });
  const verdict = needsFix(judgeResult.content) ? "FIX" : judgeResult.content.includes("<verdict>PASS</verdict>") ? "PASS" : "FIX";
  const content = `# Council Review\n\n## Verdict\n\n${verdict}\n\n${judgeResult.content}`;

  return {
    content,
    turns: reviewerResults.reduce((total, result) => total + result.turns, 0) + judgeResult.turns,
    reviews,
    judgment: judgeResult.content,
    verdict,
  };
}
