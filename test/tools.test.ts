import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pruneOldToolResults } from "../src/agent.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { executeTool, resolveWorkspacePath } from "../src/tools.ts";
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

  const approved = { ...denied, confirm: async () => true };
  assert.match(await executeTool("write_file", { path: "a.txt", content: "old" }, approved), /^Wrote /);
  assert.equal(await executeTool("replace_in_file", {
    path: "a.txt",
    old_text: "old",
    new_text: "new",
  }, approved), "Replacement applied.");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new");
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
