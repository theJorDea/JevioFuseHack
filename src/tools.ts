import { exec, execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadSkill } from "./skills.ts";
import { getSymbolIndex, invalidateSymbolIndex, lookupSymbol } from "./symbol-index.ts";
import type { AskUserOption, ExecutionMode, PluginToolRegistry, RoleName, TodoItem, ToolContext, ToolDefinition } from "./types.ts";
import { fetchWebPage } from "./web-fetch.ts";
import { searchWeb } from "./web-search.ts";

export { searchWeb } from "./web-search.ts";
export { fetchWebPage } from "./web-fetch.ts";

const PLAN_MODE_MUTATING = new Set(["write_file", "replace_in_file"]);
const EXECUTION_MODES: ExecutionMode[] = ["direct", "orchestrate", "team", "council-plan", "council-review", "plan"];

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 100_000;
const IGNORED_DIRECTORIES = new Set([".git", ".jevio", "node_modules", "dist", "build", ".next"]);

function clip(value: string, limit = MAX_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[output truncated: ${value.length - limit} characters omitted]`;
}

function changePreview(file: string, oldContent: string, newContent: string): string {
  const limit = 6_000;
  const before = oldContent.length > limit ? `${oldContent.slice(0, limit)}\n...[truncated]` : oldContent;
  const after = newContent.length > limit ? `${newContent.slice(0, limit)}\n...[truncated]` : newContent;
  return `Jevio хочет изменить ${file}\n\n--- old\n+++ new\n@@\n${before.split(/\r?\n/).map((line) => `- ${line}`).join("\n")}\n${after.split(/\r?\n/).map((line) => `+ ${line}`).join("\n")}\n\nПрименить изменения?`;
}

function shellCommandKind(command: string): "test" | "package" | "other" {
  const normalized = command.trim().toLowerCase();
  if (/^(?:npm\s+(?:test|run\s+test)|pnpm\s+test|yarn\s+test|bun\s+test|node\s+--test|deno\s+test|pytest\b|cargo\s+test|go\s+test|dotnet\s+test)\b/.test(normalized)) return "test";
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|update)\b/.test(normalized)) return "package";
  return "other";
}

function shellAllowed(command: string, mode: NonNullable<ToolContext["shellMode"]>): boolean {
  const kind = shellCommandKind(command);
  return mode === "full" || (mode === "package-manager" && (kind === "test" || kind === "package")) || (mode === "tests-only" && kind === "test");
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

export async function resolveWorkspacePath(workspace: string, requested = "."): Promise<string> {
  const root = await realpath(workspace);
  const target = path.resolve(root, requested);
  if (!isInside(root, target)) throw new Error(`Path escapes the workspace: ${requested}`);

  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in tool paths: ${requested}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

const definitions: Record<string, ToolDefinition> = {
  enter_plan_mode: {
    type: "function",
    function: {
      name: "enter_plan_mode",
      description: "Enter read-only Plan Mode before making edits. Use for non-trivial multi-file work, ambiguous design choices, or when the user asks to plan first. While active, write tools are blocked until submit_plan is approved or exit_plan_mode is called.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Short statement of what will be planned" },
        },
        additionalProperties: false,
      },
    },
  },
  exit_plan_mode: {
    type: "function",
    function: {
      name: "exit_plan_mode",
      description: "Leave Plan Mode without implementing. Use after the user rejects the plan, cancels, or when planning is no longer needed. Does not apply workspace edits.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Brief reason for leaving plan mode" },
        },
        additionalProperties: false,
      },
    },
  },
  submit_plan: {
    type: "function",
    function: {
      name: "submit_plan",
      description: "Present a complete implementation plan for user approval while in Plan Mode. On approval, Plan Mode ends and the approved plan is returned for implementation. On revise, stay in Plan Mode and refine. On reject, leave Plan Mode without edits.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description: "Full actionable plan: files, steps, risks, verification. Markdown allowed.",
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
  },
  suggest_mode: {
    type: "function",
    function: {
      name: "suggest_mode",
      description: "Switch Fuse execution mode when it would materially help. Prefer this for: council-plan (architecture/multi-module/high-risk design), council-review (independent review/audit), team (feature needing architect+coder+reviewer), plan (design first), direct (tiny edits). Call at most once, early. With apply_now=true the host may restart this task in the new mode.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["direct", "orchestrate", "team", "council-plan", "council-review", "plan"] },
          reason: { type: "string", description: "One concise user-facing reason for the recommendation" },
          apply_now: {
            type: "boolean",
            description: "If true (default), apply for the current task immediately when the host allows auto-routing. If false, only sticky for later tasks.",
          },
        },
        required: ["mode", "reason"],
        additionalProperties: false,
      },
    },
  },
  delegate_agent: {
    type: "function",
    function: {
      name: "delegate_agent",
      description: "Run an isolated specialist agent and return only its final report. Use coder for edits, architect for plans, and reviewer for verification.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["architect", "coder", "reviewer"] },
          task: { type: "string", description: "Self-contained task with all context the specialist needs" },
        },
        required: ["role", "task"],
        additionalProperties: false,
      },
    },
  },
  lookup_symbol: {
    type: "function",
    function: {
      name: "lookup_symbol",
      description: "Find declarations for a class, function, method, type, or variable without scanning the project. Also returns import references when available. For member access like authService.validateToken, search validateToken.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name or member access expression" },
          include_imports: { type: "boolean", description: "Include files importing the symbol, defaults to true" },
          max_results: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  rebuild_symbol_index: {
    type: "function",
    function: {
      name: "rebuild_symbol_index",
      description: "Force a fresh rebuild of the read-only code symbol index after broad external changes.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace with optional line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  list_files: {
    type: "function",
    function: {
      name: "list_files",
      description: "List workspace files recursively. Generated and dependency directories are skipped.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory, defaults to ." },
          max_results: { type: "integer", minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
    },
  },
  search_text: {
    type: "function",
    function: {
      name: "search_text",
      description: "Search literal text in workspace files and return file names and line numbers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string", description: "Workspace-relative directory or file" },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or fully overwrite a UTF-8 file in the workspace. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  replace_in_file: {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace one exact text block in a workspace file. Fails if the block is absent or ambiguous.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  run_command: {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace. Requires approval and has a timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  git_diff: {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show the current git diff without changing repository state.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  load_skill: {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load full instructions for a relevant skill from the advertised skill catalog.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  ask_user: {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user a decision question when the answer materially affects implementation. Offer concise options when possible. Do not ask for information that can be found in the workspace.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "A concise decision question" },
          options: {
            type: "array",
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  report_progress: {
    type: "function",
    function: {
      name: "report_progress",
      description: "Show the user a concise progress update or plan for non-trivial work. Use one short sentence; do not reveal private chain-of-thought.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
  update_todo: {
    type: "function",
    function: {
      name: "update_todo",
      description: "Maintain a concise task checklist for the user. Use for multi-step work, update statuses as work progresses, and keep at most 12 concrete items.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  },
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web (DuckDuckGo + fallbacks) for timely external information, official docs, and sources outside the workspace. Scale calls: 1 for a single fact, 3–5 for comparisons/research. Keep queries short (about 1–6 words), start broad then narrow, never repeat near-identical queries. Prefer original docs over forums. After search, use web_fetch on the best 1–2 URLs when you need full page text. Do not use for repository files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Concise search query (product + version + error phrase when useful)" },
          max_results: { type: "integer", minimum: 1, maximum: 10, description: "Number of results, default 6" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  web_fetch: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a public http(s) URL and return readable text (HTML stripped). Use after web_search to read official docs or a specific page. Private/local hosts are blocked. Do not use for workspace files — use read_file instead.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
          max_characters: { type: "integer", minimum: 1000, maximum: 40_000, description: "Max extracted characters, default 14000" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
};

const readTools = [
  "read_file",
  "list_files",
  "search_text",
  "lookup_symbol",
  "rebuild_symbol_index",
  "git_diff",
  "load_skill",
  "ask_user",
  "report_progress",
  "update_todo",
  "web_search",
  "web_fetch",
];

const planTools = ["enter_plan_mode", "exit_plan_mode", "submit_plan"];

export function toolsForRole(role: RoleName, plugins?: PluginToolRegistry): ToolDefinition[] {
  const names = role === "compactor"
    ? []
    : role === "orchestrator"
    ? [...readTools, ...planTools, "suggest_mode", "delegate_agent"]
    : role === "architect"
    ? [...readTools, ...planTools]
    : role === "judge"
      ? readTools
    : role === "reviewer"
      ? [...readTools, "run_command"]
      : [...readTools, ...planTools, "write_file", "replace_in_file", "run_command"];
  return [
    ...names.map((name) => definitions[name]),
    ...(role === "compactor" ? [] : plugins?.listTools(role) ?? []),
  ];
}

export function isPlanModeBlocking(name: string, context: ToolContext): boolean {
  return Boolean(context.planMode?.active && PLAN_MODE_MUTATING.has(name));
}

async function walkFiles(root: string, maxResults: number): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (result.length >= maxResults) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxResults) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }
  await visit(root);
  return result;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export async function executeTool(name: string, input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const outputLimit = context.maxToolOutputCharacters ?? MAX_OUTPUT;
  try {
    if (isPlanModeBlocking(name, context)) {
      return "Blocked by Plan Mode: write tools are disabled. Finish with submit_plan (for approval) or exit_plan_mode.";
    }
    if (context.plugins?.hasTool(name)) {
      if (context.planMode?.active) {
        return "Blocked by Plan Mode: MCP plugins are disabled until the plan is approved or plan mode is exited.";
      }
      return context.plugins.execute(name, input, {
        confirm: context.confirm,
        autoApprovePlugins: context.autoApprovePlugins,
        maxToolOutputCharacters: outputLimit,
      });
    }
    if (name === "enter_plan_mode") {
      const goal = String(input.goal ?? "").trim() || undefined;
      if (!context.enterPlanMode) return "Plan Mode is unavailable in this host.";
      if (context.planMode?.active) {
        return `Plan Mode is already active${context.planMode.goal ? ` (goal: ${context.planMode.goal})` : ""}. Use submit_plan or exit_plan_mode.`;
      }
      return context.enterPlanMode(goal);
    }
    if (name === "exit_plan_mode") {
      const reason = String(input.reason ?? "").trim() || undefined;
      if (!context.exitPlanMode) return "Plan Mode is unavailable in this host.";
      if (!context.planMode?.active) return "Plan Mode is not active.";
      return context.exitPlanMode(reason);
    }
    if (name === "submit_plan") {
      const plan = String(input.plan ?? "").trim();
      if (!plan) throw new Error("plan must not be empty");
      if (!context.submitPlan) return "Plan submission is unavailable in this host.";
      if (!context.planMode?.active) {
        // Auto-enter so agents can submit a plan in one step.
        if (context.enterPlanMode) await context.enterPlanMode("Submitted plan");
        else return "Plan Mode is not active and cannot be entered in this host.";
      }
      return context.submitPlan(plan);
    }
    if (name === "delegate_agent") {
      if (!context.delegate) throw new Error("Agent delegation is not configured by this host.");
      const role = String(input.role ?? "");
      if (!(["architect", "coder", "reviewer"] as string[]).includes(role)) {
        throw new Error(`Invalid specialist role '${role}'.`);
      }
      if (context.planMode?.active && role === "coder") {
        return "Blocked by Plan Mode: cannot delegate to coder until submit_plan is approved. Use architect for planning help, or submit_plan / exit_plan_mode.";
      }
      const task = String(input.task ?? "").trim();
      if (!task) throw new Error("task must not be empty");
      return context.delegate(role as "architect" | "coder" | "reviewer", task);
    }

    if (name === "suggest_mode") {
      const mode = String(input.mode ?? "") as ExecutionMode;
      const reason = String(input.reason ?? "").trim();
      const applyNow = input.apply_now !== false;
      if (!EXECUTION_MODES.includes(mode)) {
        throw new Error("Unknown execution mode.");
      }
      if (!reason) throw new Error("reason must not be empty");
      if (!context.suggestMode) return "Mode switching is unavailable in this host.";
      const accepted = await context.suggestMode(mode, reason, { applyNow });
      if (!accepted) return `Mode '${mode}' was not selected; keep the current mode and continue.`;
      return applyNow
        ? `Mode '${mode}' accepted for this task (${reason}). Stop other work now — the host will re-run the user request in '${mode}'. Do not call more tools.`
        : `Mode '${mode}' accepted for subsequent tasks (${reason}). Continue the current task in the current mode.`;
    }

    if (name === "ask_user") {
      if (!context.askUser) throw new Error("User questions are unavailable in this non-interactive run.");
      const question = String(input.question ?? "").trim();
      if (!question) throw new Error("question must not be empty");
      const options = Array.isArray(input.options)
        ? input.options.slice(0, 6).flatMap((item): AskUserOption[] => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const label = String(value.label ?? "").trim();
          return label ? [{ label, description: typeof value.description === "string" ? value.description : undefined }] : [];
        })
        : [];
      return context.askUser(question, options);
    }

    if (name === "report_progress") {
      const message = String(input.message ?? "").trim();
      if (!message) throw new Error("message must not be empty");
      await context.reportProgress?.(message);
      return "Progress update shown to the user.";
    }

    if (name === "update_todo") {
      if (!Array.isArray(input.todos)) throw new Error("todos must be an array");
      const todos = input.todos.slice(0, 12).flatMap((item): TodoItem[] => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const content = String(value.content ?? "").trim();
        const status = String(value.status ?? "");
        if (!content || !["pending", "in_progress", "completed"].includes(status)) return [];
        return [{ content, status: status as TodoItem["status"] }];
      });
      if (!todos.length) throw new Error("todos must include at least one valid item");
      await context.updateTodos?.(todos);
      return todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n");
    }

    if (name === "web_search") {
      const query = String(input.query ?? "").trim();
      if (!query) throw new Error("query must not be empty");
      return await searchWeb(query, integer(input.max_results, 6, 1, 10));
    }

    if (name === "web_fetch") {
      const url = String(input.url ?? "").trim();
      if (!url) throw new Error("url must not be empty");
      return await fetchWebPage(url, {
        maxCharacters: integer(input.max_characters, 14_000, 1_000, 40_000),
      });
    }

    if (name === "lookup_symbol") {
      if (!context.codeIndex) throw new Error("Code index is not configured by this host.");
      return lookupSymbol(context.workspace, context.codeIndex, String(input.query ?? ""), {
        includeImports: input.include_imports !== false,
        maxResults: integer(input.max_results, context.codeIndex.maxResults, 1, 100),
      });
    }

    if (name === "rebuild_symbol_index") {
      if (!context.codeIndex) throw new Error("Code index is not configured by this host.");
      const index = await getSymbolIndex(context.workspace, context.codeIndex, true);
      return `Symbol index rebuilt with ${index.backend}: ${index.indexedFiles} source files.`;
    }

    if (name === "read_file") {
      const file = await resolveWorkspacePath(context.workspace, String(input.path));
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      const start = integer(input.start_line, 1, 1, Math.max(lines.length, 1));
      const end = integer(input.end_line, Math.min(start + 399, lines.length), start, lines.length);
      return clip(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"), outputLimit);
    }

    if (name === "list_files") {
      const directory = await resolveWorkspacePath(context.workspace, String(input.path ?? "."));
      const files = await walkFiles(directory, integer(input.max_results, 500, 1, 2000));
      return clip(files.map((file) => path.relative(context.workspace, file)).join("\n") || "No files found.", outputLimit);
    }

    if (name === "search_text") {
      const query = String(input.query ?? "");
      if (!query) throw new Error("query must not be empty");
      const target = await resolveWorkspacePath(context.workspace, String(input.path ?? "."));
      const stats = await lstat(target);
      const files = stats.isDirectory() ? await walkFiles(target, 5000) : [target];
      const maxResults = integer(input.max_results, 200, 1, 500);
      const matches: string[] = [];
      for (const file of files) {
        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (line.includes(query)) {
            matches.push(`${path.relative(context.workspace, file)}:${index + 1}: ${line}`);
            if (matches.length >= maxResults) return clip(matches.join("\n"), outputLimit);
          }
        }
      }
      return clip(matches.join("\n") || "No matches found.", outputLimit);
    }

    if (name === "write_file") {
      const file = await resolveWorkspacePath(context.workspace, String(input.path));
      const content = String(input.content ?? "");
      const existing = await readFile(file, "utf8").catch(() => "");
      const approved = context.autoApproveWrites || await context.confirm(changePreview(path.relative(context.workspace, file), existing, content));
      if (!approved) return "Permission denied by user.";
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      invalidateSymbolIndex(context.workspace);
      context.onWorkspaceChange?.();
      return `Wrote ${Buffer.byteLength(String(input.content ?? ""), "utf8")} bytes.`;
    }

    if (name === "replace_in_file") {
      const file = await resolveWorkspacePath(context.workspace, String(input.path));
      const oldText = String(input.old_text ?? "");
      if (!oldText) throw new Error("old_text must not be empty");
      const content = await readFile(file, "utf8");
      const first = content.indexOf(oldText);
      if (first < 0) throw new Error("old_text was not found");
      if (content.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_text occurs more than once; include more context");
      const replacement = `${content.slice(0, first)}${String(input.new_text ?? "")}${content.slice(first + oldText.length)}`;
      const approved = context.autoApproveWrites || await context.confirm(changePreview(path.relative(context.workspace, file), content, replacement));
      if (!approved) return "Permission denied by user.";
      await writeFile(file, replacement, "utf8");
      invalidateSymbolIndex(context.workspace);
      context.onWorkspaceChange?.();
      return "Replacement applied.";
    }

    if (name === "run_command") {
      const command = String(input.command ?? "").trim();
      if (!command) throw new Error("command must not be empty");
      if (context.planMode?.active && shellCommandKind(command) !== "test") {
        return "Blocked by Plan Mode: only test commands are allowed. Use read tools, submit_plan, or exit_plan_mode.";
      }
      const shellMode = context.shellMode ?? "full";
      const commandKind = shellCommandKind(command);
      if (!shellAllowed(command, shellMode)) {
        return `Command blocked by shellMode '${shellMode}'.`;
      }
      const requiresExplicitApproval = shellMode === "package-manager" && commandKind === "package";
      const approved = !requiresExplicitApproval && context.autoApproveShell || await context.confirm(`Разрешить shell-команду (${shellMode})?\n  ${command}`);
      if (!approved) return "Permission denied by user.";
      const timeout = integer(input.timeout_ms, 120_000, 1000, 600_000);
      try {
        const result = await execAsync(command, {
          cwd: context.workspace,
          timeout,
          maxBuffer: MAX_OUTPUT * 2,
          windowsHide: true,
        });
        if (commandKind === "test") {
          context.recordVerification?.({
            command,
            exitCode: 0,
            summary: clip(`${result.stdout}${result.stderr}`.trim() || "Command completed without output.", 1_000),
          });
        }
        return clip(`exit: 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, outputLimit);
      } catch (error) {
        const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (commandKind === "test") {
          context.recordVerification?.({
            command,
            exitCode: failed.code ?? "failed",
            summary: clip(`${failed.stdout ?? ""}${failed.stderr ?? failed.message}`.trim(), 1_000),
          });
        }
        return clip(`exit: ${failed.code ?? "failed"}\nstdout:\n${failed.stdout ?? ""}\nstderr:\n${failed.stderr ?? failed.message}`, outputLimit);
      }
    }

    if (name === "git_diff") {
      try {
        const result = await execFileAsync("git", ["diff", "--no-ext-diff", "--"], {
          cwd: context.workspace,
          maxBuffer: MAX_OUTPUT * 2,
          windowsHide: true,
        });
        return clip(result.stdout || "Working tree diff is empty.", outputLimit);
      } catch (error) {
        return `Unable to read git diff: ${(error as Error).message}`;
      }
    }

    if (name === "load_skill") {
      const requested = String(input.name ?? "");
      const skill = context.skills.find((item) => item.name === requested);
      if (!skill) throw new Error(`Unknown skill '${requested}'`);
      if (!skill.modelInvocable) throw new Error(`Skill '${requested}' is manual-only.`);
      return clip(await loadSkill(skill), outputLimit);
    }

    throw new Error(`Unknown tool '${name}'`);
  } catch (error) {
    return `Tool error: ${(error as Error).message}`;
  }
}
