import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runAgent, type AgentEvent } from "./agent.ts";
import { gatherKairosSignals } from "./kairos.ts";
import { loadProjectMemory } from "./session.ts";
import { buildRepositoryMap } from "./symbol-index.ts";
import type { JevioConfig, ToolContext } from "./types.ts";

export interface IdeasOptions {
  workspace: string;
  config: JevioConfig;
  toolContext: ToolContext;
  /** Optional focus: "UX", "performance", "DX", free text */
  topic?: string;
  count?: number;
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
}

export interface ProjectIdeaSignals {
  packageName?: string;
  packageDescription?: string;
  scripts: string[];
  readmeExcerpt: string;
  topLevel: string[];
  memoryExcerpt: string;
  kairosSummary: string;
  repoMapExcerpt: string;
}

async function readOptional(file: string, max = 4_000): Promise<string> {
  try {
    return (await readFile(file, "utf8")).slice(0, max);
  } catch {
    return "";
  }
}

/** Gather lightweight project signals for brainstorming (no model). */
export async function gatherIdeaSignals(workspace: string, config: JevioConfig): Promise<ProjectIdeaSignals> {
  const root = path.resolve(workspace);
  const [pkgRaw, readme, memory, kairos, entries] = await Promise.all([
    readOptional(path.join(root, "package.json"), 8_000),
    readOptional(path.join(root, "README.md"), 3_000),
    loadProjectMemory(workspace),
    gatherKairosSignals(workspace),
    readdir(root, { withFileTypes: true }).catch(() => []),
  ]);

  let packageName: string | undefined;
  let packageDescription: string | undefined;
  let scripts: string[] = [];
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        name?: string;
        description?: string;
        scripts?: Record<string, string>;
      };
      packageName = typeof pkg.name === "string" ? pkg.name : undefined;
      packageDescription = typeof pkg.description === "string" ? pkg.description : undefined;
      scripts = Object.keys(pkg.scripts ?? {}).slice(0, 20);
    } catch {
      // ignore malformed package.json
    }
  }

  let repoMapExcerpt = "";
  try {
    repoMapExcerpt = (await buildRepositoryMap(workspace, config.codeIndex)).slice(0, 6_000);
  } catch {
    repoMapExcerpt = "";
  }

  const topLevel = entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .slice(0, 40)
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"}:${entry.name}`);

  return {
    packageName,
    packageDescription,
    scripts,
    readmeExcerpt: readme,
    topLevel,
    memoryExcerpt: memory.trim().slice(0, 3_000),
    kairosSummary: kairos.summary,
    repoMapExcerpt,
  };
}

export function formatIdeaSignals(signals: ProjectIdeaSignals): string {
  return [
    signals.packageName ? `Package: ${signals.packageName}` : "",
    signals.packageDescription ? `Description: ${signals.packageDescription}` : "",
    signals.scripts.length ? `Scripts: ${signals.scripts.join(", ")}` : "",
    signals.topLevel.length ? `Top-level:\n${signals.topLevel.map((item) => `- ${item}`).join("\n")}` : "",
    signals.kairosSummary ? `Workspace pulse: ${signals.kairosSummary}` : "",
    signals.memoryExcerpt ? `MEMORY.md excerpt:\n${signals.memoryExcerpt}` : "",
    signals.readmeExcerpt ? `README excerpt:\n${signals.readmeExcerpt}` : "",
    signals.repoMapExcerpt ? `Repository map excerpt:\n${signals.repoMapExcerpt}` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * Brainstorm concrete, repo-grounded product/engineering ideas.
 * Uses architect role with elevated temperature; tools allowed for extra inspection.
 */
export async function generateIdeas(options: IdeasOptions): Promise<string> {
  const count = Math.max(3, Math.min(12, options.count ?? 7));
  const topic = options.topic?.trim();
  options.onEvent?.({ type: "thinking", role: "architect", detail: "ideas: gathering project signals" });
  const signals = await gatherIdeaSignals(options.workspace, options.config);
  const signalText = formatIdeaSignals(signals);

  const brainstormConfig = structuredClone(options.config);
  const baseTemp = brainstormConfig.roles.architect.temperature ?? 0.25;
  brainstormConfig.roles.architect.temperature = Math.min(0.95, Math.max(0.55, baseTemp + 0.4));
  brainstormConfig.roles.architect.maxTokens = Math.max(
    brainstormConfig.roles.architect.maxTokens ?? 0,
    2_400,
  ) || 2_400;

  options.onEvent?.({ type: "thinking", role: "architect", detail: "ideas: brainstorming with architect" });
  const result = await (options.runner ?? runAgent)({
    role: "architect",
    task: `You are brainstorming for this codebase (idea generator mode).

## Project signals
${signalText || "(minimal signals — still propose useful product/engineering directions)"}

## Focus
${topic ? `User focus: ${topic}` : "No special focus — cover product value, DX, reliability, and polish."}

## Output rules
Generate ${count} concrete ideas. Each idea MUST:
1. Be grounded in THIS repo (reference real folders/files/scripts when possible).
2. Be actionable in 1–3 days for a coding agent.
3. Include: title, why it matters, rough approach (files/areas), effort (S/M/L), impact (S/M/L).

Prefer a mix: quick wins, medium features, one ambitious idea.
Do NOT invent APIs that clearly cannot exist; if unsure, say "inspect first".
You may use read-only tools to spot real gaps, but keep tool use light.
Write in the same language as the user focus (default Russian if focus is Russian or empty).

Format as Markdown:
### 1. Title
- **Why:** ...
- **How:** ...
- **Effort / impact:** S|M|L / S|M|L
- **Start:** first concrete step
`,
    config: brainstormConfig,
    toolContext: {
      ...options.toolContext,
      // Ideas stay read-only even if host is in YOLO.
      autoApproveWrites: false,
      autoApproveShell: false,
    },
    maxTurns: 6,
    onEvent: options.onEvent,
  });

  const body = result.content.trim();
  if (!body || body === "The model returned an empty response.") {
    throw new Error("Idea generator returned an empty response.");
  }
  return [
    `# Идеи для ${signals.packageName || path.basename(path.resolve(options.workspace))}`,
    topic ? `Фокус: ${topic}` : "",
    "",
    body,
    "",
    "---",
    "_Сгенерировано `/ideas`. Скажи Fuse, какую идею реализовать — или `/team` / `/plan`._",
  ].filter(Boolean).join("\n");
}
