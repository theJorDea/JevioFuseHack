import { runAgent, type AgentEvent } from "./agent.ts";
import type { ChatMessage, JevioConfig, ToolContext } from "./types.ts";

export type CritiqueVerdict = "PASS" | "IMPROVE" | "FIX";

export interface CritiqueResult {
  content: string;
  verdict: CritiqueVerdict;
  turns: number;
}

export interface CritiqueOptions {
  config: JevioConfig;
  toolContext: ToolContext;
  /** Original user request (optional context for the critic). */
  userRequest?: string;
  /** Extra focus, e.g. "security" or "UX". */
  focus?: string;
  history?: ChatMessage[];
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
  maxTurns?: number;
}

export function parseCritiqueVerdict(text: string): CritiqueVerdict {
  if (/<verdict>\s*FIX\s*<\/verdict>/i.test(text)) return "FIX";
  if (/<verdict>\s*IMPROVE\s*<\/verdict>/i.test(text)) return "IMPROVE";
  if (/<verdict>\s*PASS\s*<\/verdict>/i.test(text)) return "PASS";
  // Heuristic if the model forgot the marker.
  if (/\b(critical|must fix|blocker|уязвим|критич)/i.test(text)) return "FIX";
  if (/\b(improve|consider|optional|можно улучшить|рекоменд)/i.test(text)) return "IMPROVE";
  return "PASS";
}

/**
 * Lightweight post-implementation critic (single reviewer).
 * Inspects git_diff / code and returns structured advice.
 * Unlike council-review: one model call, advice-first, not a three-way council.
 */
export async function runCritique(options: CritiqueOptions): Promise<CritiqueResult> {
  const runner = options.runner ?? runAgent;
  const focus = options.focus?.trim();
  const userRequest = options.userRequest?.trim();
  const task = `You are a senior code critic reviewing the CURRENT workspace changes.

## Your job
1. Call git_diff (and read key files) — do not invent findings without tool evidence.
2. Prioritize: correctness bugs, security, broken contracts, missing verification.
3. Then suggest concrete improvements (DX, readability, tests, edge cases) — not style nits.
4. Be concise. Each finding: path + why + what to do.

## Output format (Markdown)
### Critical
- ... or "None."
### Improvements
- ... or "None."
### Tests / verification
- ... or "None."
### Summary
One short paragraph.

End with exactly one verdict marker:
- <verdict>PASS</verdict> — safe as-is, no material issues
- <verdict>IMPROVE</verdict> — works, but optional improvements listed
- <verdict>FIX</verdict> — must fix critical issues before considering done

${userRequest ? `## Original user request\n${userRequest}\n` : ""}
${focus ? `## Extra focus\n${focus}\n` : ""}
If the working tree has no relevant diff, say so and use <verdict>PASS</verdict> (or FIX if the user claimed edits that are missing).
`;

  const result = await runner({
    role: "reviewer",
    task,
    config: options.config,
    toolContext: {
      ...options.toolContext,
      // Critique is read-only advice; never write.
      autoApproveWrites: false,
    },
    history: options.history,
    maxTurns: options.maxTurns ?? Math.min(10, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });

  return {
    content: result.content.trim(),
    verdict: parseCritiqueVerdict(result.content),
    turns: result.turns,
  };
}

/** Format critique for appending to a user-facing turn. */
export function formatCritiqueAppendix(result: CritiqueResult): string {
  const badge = result.verdict === "FIX"
    ? "нужны правки"
    : result.verdict === "IMPROVE"
      ? "можно улучшить"
      : "ок";
  return [
    "### 🔍 Code critique",
    `_Verdict: **${result.verdict}** (${badge})_`,
    "",
    result.content,
    "",
    "_Дальше: `/critique fix` — попросить coder исправить · `/council-review` — полный совет ревьюеров_",
  ].join("\n");
}
