import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAgent, type AgentEvent } from "./agent.ts";
import { dreamStatus } from "./dream.ts";
import { listSessions, loadProjectMemory } from "./session.ts";
import type { ChatMessage, JevioConfig, ToolContext } from "./types.ts";

const execFileAsync = promisify(execFile);

export type KairosSeverity = "info" | "watch" | "action";

export interface KairosSignal {
  id: string;
  severity: KairosSeverity;
  title: string;
  detail: string;
}

export interface KairosObservation {
  signals: KairosSignal[];
  raw: {
    gitStatus: string;
    gitDiffStat: string;
    uncommittedCount: number;
    memoryCharacters: number;
    pendingDreamSessions: number;
    recentSessions: string[];
  };
  summary: string;
  observedAt: string;
}

export interface KairosResult extends KairosObservation {
  synthesis?: string;
}

async function gitText(workspace: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: workspace,
      maxBuffer: 200_000,
      windowsHide: true,
      timeout: 8_000,
    });
    return (result.stdout || "").trim();
  } catch (error) {
    return `git unavailable: ${(error as Error).message}`;
  }
}

function countStatusLines(status: string): number {
  if (!status || status.startsWith("git unavailable")) return 0;
  return status.split(/\r?\n/).filter((line) => line.trim()).length;
}

/** Deterministic proactive scan — no model required. */
export async function gatherKairosSignals(workspace: string): Promise<KairosObservation> {
  const [gitStatus, gitDiffStat, memory, sessions, dream] = await Promise.all([
    gitText(workspace, ["status", "--short"]),
    gitText(workspace, ["diff", "--stat", "HEAD"]),
    loadProjectMemory(workspace),
    listSessions(workspace),
    dreamStatus(workspace),
  ]);

  const uncommittedCount = countStatusLines(gitStatus);
  const recentSessions = sessions.slice(0, 5).map((session) =>
    `${session.title} (${session.messageCount} msgs, ${session.updatedAt.slice(0, 16)})`,
  );
  const signals: KairosSignal[] = [];

  if (uncommittedCount > 0) {
    signals.push({
      id: "dirty-tree",
      severity: uncommittedCount >= 8 ? "action" : "watch",
      title: "Незакоммиченные изменения",
      detail: `${uncommittedCount} путей в git status${gitDiffStat && !gitDiffStat.startsWith("git unavailable") ? `\n${gitDiffStat.slice(0, 800)}` : ""}`,
    });
  } else if (!gitStatus.startsWith("git unavailable")) {
    signals.push({
      id: "clean-tree",
      severity: "info",
      title: "Рабочее дерево чистое",
      detail: "Нет незакоммиченных изменений.",
    });
  } else {
    signals.push({
      id: "no-git",
      severity: "info",
      title: "Git недоступен",
      detail: gitStatus,
    });
  }

  if (!memory.trim()) {
    signals.push({
      id: "empty-memory",
      severity: "watch",
      title: "MEMORY.md пуст",
      detail: "Долговременная память проекта не заполнена. После задач имеет смысл /dream или /memory add.",
    });
  } else if (memory.length > 20_000) {
    signals.push({
      id: "large-memory",
      severity: "watch",
      title: "MEMORY.md разросся",
      detail: `${memory.length} символов — стоит /dream force для prune.`,
    });
  }

  if (dream.pendingSessions > 0) {
    signals.push({
      id: "pending-dream",
      severity: dream.pendingMessages >= 10 ? "action" : "watch",
      title: "Очередь на /dream",
      detail: `${dream.pendingSessions} сессий / ${dream.pendingMessages} сообщений ждут консолидации.`,
    });
  }

  if (sessions.length === 0) {
    signals.push({
      id: "no-sessions",
      severity: "info",
      title: "Сессий ещё нет",
      detail: "Это свежий workspace для Jevio.",
    });
  } else if (sessions[0] && sessions[0].messageCount >= 30) {
    signals.push({
      id: "long-session",
      severity: "watch",
      title: "Длинная текущая сессия",
      detail: `"${sessions[0].title}" — ${sessions[0].messageCount} сообщений. Полезен /compact.`,
    });
  }

  const actionCount = signals.filter((signal) => signal.severity === "action").length;
  const watchCount = signals.filter((signal) => signal.severity === "watch").length;
  const summary = actionCount
    ? `KAIROS: ${actionCount} действий, ${watchCount} наблюдений.`
    : watchCount
      ? `KAIROS: ${watchCount} наблюдений, срочных действий нет.`
      : "KAIROS: всё спокойно.";

  return {
    signals,
    raw: {
      gitStatus: gitStatus.slice(0, 4_000),
      gitDiffStat: gitDiffStat.slice(0, 2_000),
      uncommittedCount,
      memoryCharacters: memory.length,
      pendingDreamSessions: dream.pendingSessions,
      recentSessions,
    },
    summary,
    observedAt: new Date().toISOString(),
  };
}

export function formatKairosReport(observation: KairosObservation, synthesis?: string): string {
  const lines = [
    `## ${observation.summary}`,
    `Наблюдение: ${observation.observedAt}`,
    "",
    ...observation.signals.map((signal) => {
      const mark = signal.severity === "action" ? "🔴" : signal.severity === "watch" ? "🟡" : "🟢";
      return `${mark} **${signal.title}** (${signal.severity})\n${signal.detail}`;
    }),
  ];
  if (observation.raw.recentSessions.length) {
    lines.push("", "### Недавние сессии", ...observation.raw.recentSessions.map((item) => `- ${item}`));
  }
  if (synthesis?.trim()) {
    lines.push("", "### Синтез", synthesis.trim());
  }
  return lines.join("\n");
}

/** Whether auto-KAIROS should fire after a successful turn. */
export function shouldAutoKairos(
  observation: KairosObservation,
  options: { minSeverity?: KairosSeverity } = {},
): boolean {
  const min = options.minSeverity ?? "watch";
  const rank: Record<KairosSeverity, number> = { info: 0, watch: 1, action: 2 };
  const threshold = rank[min];
  return observation.signals.some((signal) => rank[signal.severity] >= threshold);
}

export async function runKairos(options: {
  workspace: string;
  config: JevioConfig;
  toolContext: ToolContext;
  history?: ChatMessage[];
  synthesize?: boolean;
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
}): Promise<KairosResult> {
  options.onEvent?.({ type: "thinking", role: "orchestrator", detail: "kairos: gathering workspace signals" });
  const observation = await gatherKairosSignals(options.workspace);

  if (!options.synthesize) {
    return { ...observation };
  }

  options.onEvent?.({ type: "thinking", role: "orchestrator", detail: "kairos: synthesizing proactive advice" });
  try {
    const report = formatKairosReport(observation);
    const result = await (options.runner ?? runAgent)({
      role: "compactor",
      task: `You are KAIROS, a proactive coding-session observer. Given deterministic workspace signals, write 3-6 short Russian bullet suggestions for what the developer should do next (or confirm all is fine). No tools. No invention of repo facts beyond the signals.

SIGNALS:
${report}

Return only the bullet list.`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history?.slice(-4),
      maxTurns: 1,
      onEvent: options.onEvent,
    });
    const synthesis = result.content.trim();
    if (!synthesis || synthesis === "The model returned an empty response.") {
      return { ...observation };
    }
    return { ...observation, synthesis: synthesis.slice(0, 4_000) };
  } catch {
    return { ...observation };
  }
}
