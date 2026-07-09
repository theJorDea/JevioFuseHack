import { exec, execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadSkill } from "./skills.ts";
import { getSymbolIndex, invalidateSymbolIndex, lookupSymbol } from "./symbol-index.ts";
import type { RoleName, ToolContext, ToolDefinition } from "./types.ts";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 100_000;
const IGNORED_DIRECTORIES = new Set([".git", ".jevio", "node_modules", "dist", "build", ".next"]);

function clip(value: string, limit = MAX_OUTPUT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[output truncated: ${value.length - limit} characters omitted]`;
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
};

const readTools = [
  "read_file",
  "list_files",
  "search_text",
  "lookup_symbol",
  "rebuild_symbol_index",
  "git_diff",
  "load_skill",
];

export function toolsForRole(role: RoleName): ToolDefinition[] {
  const names = role === "compactor"
    ? []
    : role === "orchestrator"
    ? [...readTools, "delegate_agent"]
    : role === "architect"
    ? readTools
    : role === "reviewer"
      ? [...readTools, "run_command"]
      : [...readTools, "write_file", "replace_in_file", "run_command"];
  return names.map((name) => definitions[name]);
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
    if (name === "delegate_agent") {
      if (!context.delegate) throw new Error("Agent delegation is not configured by this host.");
      const role = String(input.role ?? "");
      if (!(["architect", "coder", "reviewer"] as string[]).includes(role)) {
        throw new Error(`Invalid specialist role '${role}'.`);
      }
      const task = String(input.task ?? "").trim();
      if (!task) throw new Error("task must not be empty");
      return context.delegate(role as "architect" | "coder" | "reviewer", task);
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
      const approved = context.autoApproveWrites || await context.confirm(`Allow writing ${path.relative(context.workspace, file)}?`);
      if (!approved) return "Permission denied by user.";
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, String(input.content ?? ""), "utf8");
      invalidateSymbolIndex(context.workspace);
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
      const approved = context.autoApproveWrites || await context.confirm(`Allow editing ${path.relative(context.workspace, file)}?`);
      if (!approved) return "Permission denied by user.";
      await writeFile(file, `${content.slice(0, first)}${String(input.new_text ?? "")}${content.slice(first + oldText.length)}`, "utf8");
      invalidateSymbolIndex(context.workspace);
      return "Replacement applied.";
    }

    if (name === "run_command") {
      const command = String(input.command ?? "").trim();
      if (!command) throw new Error("command must not be empty");
      const approved = context.autoApproveShell || await context.confirm(`Allow shell command?\n  ${command}`);
      if (!approved) return "Permission denied by user.";
      const timeout = integer(input.timeout_ms, 120_000, 1000, 600_000);
      try {
        const result = await execAsync(command, {
          cwd: context.workspace,
          timeout,
          maxBuffer: MAX_OUTPUT * 2,
          windowsHide: true,
        });
        return clip(`exit: 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, outputLimit);
      } catch (error) {
        const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
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
