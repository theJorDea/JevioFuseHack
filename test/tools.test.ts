import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pruneOldToolResults } from "../src/agent.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { executeTool, resolveWorkspacePath, searchWeb, toolsForRole } from "../src/tools.ts";
import type { ToolContext } from "../src/types.ts";

async function workspace(t: Parameters<typeof test>[1] extends (arg: infer T) => unknown ? T : never): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-tools-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  (t as { after(callback: () => unknown): void }).after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("workspace path guard rejects parent traversal", async (t) => {
  const root = await workspace(t);
  await assert.rejects(() => resolveWorkspacePath(root, "../outside.txt"), /escapes the workspace/);
});

test("write tools require approval and exact replacement", async (t) => {
  const root = await workspace(t);
  const denied: ToolContext = {
    workspace: root,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  assert.equal(await executeTool("write_file", { path: "a.txt", content: "old" }, denied), "Permission denied by user.");

  let workspaceChanges = 0;
  let preview = "";
  const approved = {
    ...denied,
    confirm: async (message: string) => {
      preview = message;
      return true;
    },
    onWorkspaceChange: () => { workspaceChanges += 1; },
  };
  assert.match(await executeTool("write_file", { path: "a.txt", content: "old" }, approved), /^Wrote /);
  assert.equal(await executeTool("replace_in_file", {
    path: "a.txt",
    old_text: "old",
    new_text: "new",
  }, approved), "Replacement applied.");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new");
  assert.equal(workspaceChanges, 2);
  assert.match(preview, /--- old/);
  assert.match(preview, /\+\+\+ new/);
});

test("shell mode blocks commands outside its policy", async (t) => {
  const root = await workspace(t);
  const verifications: Array<{ command: string; exitCode: number | string; summary: string }> = [];
  const context: ToolContext = {
    workspace: root,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: true,
    shellMode: "tests-only",
    confirm: async () => true,
    recordVerification: (record) => { verifications.push(record); },
  };
  assert.equal(await executeTool("run_command", { command: "npm install" }, context), "Command blocked by shellMode 'tests-only'.");
  assert.match(await executeTool("run_command", { command: "node --test" }, context), /exit: 0/);
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].command, "node --test");
  assert.equal(verifications[0].exitCode, 0);
  assert.equal(await executeTool("run_command", { command: "npm install" }, { ...context, shellMode: "package-manager", confirm: async () => false }), "Permission denied by user.");
});

test("search reports relative paths and line numbers", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "sample.ts"), "first\nneedle here\nthird\n");
  const context: ToolContext = {
    workspace: root,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  assert.equal(
    await executeTool("search_text", { query: "needle" }, context),
    "sample.ts:2: needle here",
  );
});

test("report_progress forwards through the tool context", async () => {
  let progress = "";
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
    reportProgress: (message) => { progress = message; },
  };
  assert.equal(await executeTool("report_progress", { message: "Inspecting files" }, context), "Progress update shown to the user.");
  assert.equal(progress, "Inspecting files");
});

test("agents can ask the interactive user a structured question", async () => {
  let todos: Array<{ content: string; status: string }> = [];
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
    askUser: async (questionOrRequest, options) => {
      if (typeof questionOrRequest === "string") {
        return `q1: ${options?.[0]?.label ?? ""}`;
      }
      return questionOrRequest.questions
        .map((item) => `${item.id}: ${(item.options ?? [])[0]?.label ?? ""}`)
        .join("\n");
    },
    updateTodos: (items) => { todos = items; },
  };
  const result = await executeTool("ask_user", {
    question: "Which layout?",
    options: [{ label: "Grid", description: "Responsive cards" }],
  }, context);
  assert.equal(result, "q1: Grid");
  assert.ok(toolsForRole("coder").some((tool) => tool.function.name === "ask_user"));

  const multi = await executeTool("ask_user", {
    header: "Нужны решения по UI",
    questions: [
      {
        id: "layout",
        question: "Layout?",
        options: [{ label: "Grid" }, { label: "List" }],
      },
      {
        id: "theme",
        question: "Theme features?",
        multi_select: true,
        options: [{ label: "Dark" }, { label: "Motion" }],
      },
    ],
  }, context);
  assert.match(multi, /layout: Grid/);
  assert.match(multi, /theme: Dark/);

  assert.equal(await executeTool("report_progress", { message: "Inspecting the project structure." }, context), "Progress update shown to the user.");
  assert.match(
    await executeTool("update_todo", {
      todos: [
        { content: "Inspect files", status: "in_progress" },
        { content: "Write code", status: "pending" },
      ],
    }, context),
    /ToDo 0\/2 done/,
  );
  assert.deepEqual(todos, [
    { content: "Inspect files", status: "in_progress" },
    { content: "Write code", status: "pending" },
  ]);
  // Only one in_progress — demote extras
  assert.match(
    await executeTool("update_todo", {
      todos: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "in_progress" },
      ],
    }, context),
    /only one in_progress/,
  );
  assert.equal(todos.filter((item) => item.status === "in_progress").length, 1);
  assert.ok(toolsForRole("coder").some((tool) => tool.function.name === "report_progress"));
  assert.ok(toolsForRole("coder").some((tool) => tool.function.name === "web_search"));
  assert.ok(toolsForRole("coder").some((tool) => tool.function.name === "web_fetch"));
});

test("parseAskUserRequest accepts legacy and batch forms", async () => {
  const { parseAskUserRequest } = await import("../src/tools.ts");
  const legacy = parseAskUserRequest({
    question: "Pick one",
    options: [{ label: "A" }],
    multi_select: true,
  });
  assert.equal(legacy.questions.length, 1);
  assert.equal(legacy.questions[0].multiSelect, true);
  assert.equal(legacy.questions[0].options?.[0].label, "A");

  const batch = parseAskUserRequest({
    header: "Context",
    questions: [{ question: "Q?", options: [{ label: "Yes" }], id: "confirm" }],
  });
  assert.equal(batch.header, "Context");
  assert.equal(batch.questions[0].id, "confirm");
});

test("web_fetch tool rejects private hosts without network", async () => {
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  assert.match(
    await executeTool("web_fetch", { url: "http://127.0.0.1/secret" }, context),
    /blocked|Tool error/i,
  );
});

test("web_search tool uses multi-backend searchWeb", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("html.duckduckgo.com")) {
      return new Response(`
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fdocs">Official docs</a>
        <a class="result__snippet">Useful reference</a>
      `);
    }
    return new Response("{}", { status: 200 });
  };
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  const results = await executeTool("web_search", { query: "example", max_results: 3 }, context);
  assert.match(results, /Official docs/);
  assert.match(results, /https:\/\/example\.test\/docs/);
  assert.match(results, /Useful reference/);
  // Legacy helper export still works for callers/tests.
  assert.match(await searchWeb("example", 3), /Official docs/);
});

test("root agent can delegate into an isolated specialist", async (t) => {
  const root = await workspace(t);
  const context: ToolContext = {
    workspace: root,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
    delegate: async (role, task) => `${role}: ${task}`,
  };
  assert.equal(
    await executeTool("delegate_agent", { role: "architect", task: "map the data flow" }, context),
    "architect: map the data flow",
  );
});

test("orchestrator can suggest a persistent execution mode", async () => {
  let suggested = "";
  let applyNow: boolean | undefined;
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
    suggestMode: async (mode, reason, options) => {
      suggested = `${mode}: ${reason}`;
      applyNow = options?.applyNow;
      return true;
    },
  };
  assert.match(await executeTool("suggest_mode", {
    mode: "council-plan",
    reason: "The change crosses several architectural boundaries.",
  }, context), /accepted for this task/);
  assert.equal(suggested, "council-plan: The change crosses several architectural boundaries.");
  assert.equal(applyNow, true);
  assert.ok(toolsForRole("orchestrator").some((tool) => tool.function.name === "suggest_mode"));
  assert.ok(!toolsForRole("coder").some((tool) => tool.function.name === "suggest_mode"));
});

test("workspace discovery does not expose private Jevio session files", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, ".jevio", "sessions"), { recursive: true });
  await writeFile(path.join(root, ".jevio", "sessions", "private.md"), "private transcript");
  await writeFile(path.join(root, "visible.md"), "visible");
  const context: ToolContext = {
    workspace: root,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  assert.equal(await executeTool("list_files", {}, context), "visible.md");
  assert.equal(await executeTool("search_text", { query: "private transcript" }, context), "No matches found.");
});

test("old tool results are pruned without breaking tool message identity", () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({
    role: "tool" as const,
    tool_call_id: `call-${index}`,
    content: `large output ${index}`,
  }));
  pruneOldToolResults(messages, 2);
  assert.match(String(messages[0].content), /omitted/);
  assert.match(String(messages[2].content), /omitted/);
  assert.equal(messages[3].content, "large output 3");
  assert.equal(messages[0].tool_call_id, "call-0");
});

test("lookup_symbol is exposed as a read-only model tool", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "auth.ts"), "export function validateToken(token: string) { return Boolean(token); }\n");
  const context: ToolContext = {
    workspace: root,
    skills: [],
    codeIndex: { ...DEFAULT_CONFIG.codeIndex, backend: "builtin" },
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  const result = await executeTool("lookup_symbol", { query: "validateToken" }, context);
  assert.match(result, /auth\.ts:1 \[function\]/);
});
