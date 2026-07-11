import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { formatActivityBody, formatActivitySummary, InteractiveTui, parseToolEventDetail } from "../src/interactive-tui.ts";
import { summarizeToolCall, summarizeToolResult } from "../src/agent.ts";
import { executeTool } from "../src/tools.ts";
import type { Terminal } from "@earendil-works/pi-tui";

function testTerminal(): Terminal {
  return {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    drainInput: async () => {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}

function createTui(): InteractiveTui {
  return new InteractiveTui({
    workspace: process.cwd(),
    terminal: testTerminal(),
    submit: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => "",
    getSession: () => ({ id: "tui-test", title: "TUI test", messageCount: 1 }),
    getMode: () => "direct",
    getProvider: () => "test",
    getModel: () => "test-model",
    listProviders: async () => [],
    selectProvider: async () => "",
    listModels: async () => ({ provider: "test", models: ["test-model", "other-model"], current: "test-model" }),
    selectModel: async () => "",
    addProvider: async () => "",
    listRoleConfigs: async () => [
      { role: "orchestrator", provider: "test", model: "test-model" },
      { role: "coder", provider: "test", model: "test-model" },
      { role: "architect", provider: "test", model: "test-model" },
      { role: "reviewer", provider: "test", model: "test-model" },
      { role: "judge", provider: "test", model: "test-model" },
      { role: "compactor", provider: "test", model: "test-model" },
    ],
    listPlugins: async () => "MCP-плагины не настроены.",
    configureRole: async (role, provider, model) => `${role}: ${provider} / ${model}`,
    setupReport: async () => "",
  });
}

type TuiInternals = {
  tui: {
    focusedComponent: {
      handleInput(input: string): void;
      getSelectedItem?(): { value: string } | null;
    };
    overlayStack: Array<{ component: { render(width: number): string[] } }>;
    handleInput(input: string): void;
    hasOverlay(): boolean;
    stop(): void;
  };
  thinkingBlocks: Array<{ expanded: boolean; text: string; streaming: boolean; heading: { getText?: () => string; setText: (t: string) => void }; component: { getText?: () => string; setText: (t: string) => void } }>;
  activityBlocks: Array<{
    tools: Array<{ name: string; status: string; meta: string }>;
    body: { text?: string; render(width: number): string[] };
    heading: { render(width: number): string[] };
    frozen: boolean;
    expanded: boolean;
  }>;
  liveActivity?: {
    tools: Array<{ name: string; status: string; meta: string }>;
    body: { text?: string; render(width: number): string[] };
    heading: { render(width: number): string[] };
    frozen: boolean;
    expanded: boolean;
  };
  collapsibles: Array<{ kind: string; getExpanded(): boolean; setExpanded(value: boolean): void }>;
  freezeLiveActivity(): void;
  toggleLatestCollapsible(): void;
  setAllCollapsibles(expanded: boolean): void;
  reportEvent(event: { type: string; role: string; detail: string }): void;
  transcript: { children: Array<{ render(width: number): string[] }> };
};

function internals(ui: InteractiveTui): TuiInternals {
  return ui as unknown as TuiInternals;
}

function transcriptText(ui: InteractiveTui): string {
  const state = internals(ui);
  return state.transcript.children.map((child) => child.render(100).join("\n")).join("\n");
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("long change previews keep approval choices visible and gate writes", async (t) => {
  const workspace = await mkdtemp(path.join(process.cwd(), ".tmp-test-tui-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const ui = createTui();
  const state = internals(ui);
  t.after(() => state.tui.stop());
  const context = {
    workspace,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: (message: string) => ui.confirm(message),
  };

  const write = executeTool("write_file", {
    path: "nested/change.txt",
    content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
  }, context);
  await nextTurn();
  const visible = state.tui.overlayStack[0].component.render(48).join("\n");
  assert.match(visible, /\+ line 1/);
  assert.match(visible, /Diff:/);
  assert.match(visible, /Jevio/);
  assert.match(visible, /Разрешить/);
  assert.match(visible, /Отклонить/);
  state.tui.handleInput("\u001b[6~");
  state.tui.handleInput("\u001b[6~");
  const nextPage = state.tui.overlayStack[0].component.render(48).join("\n");
  assert.match(nextPage, /\+ line 20/);
  state.tui.focusedComponent.handleInput("\n");
  assert.match(await write, /^Wrote /);

  const replace = executeTool("replace_in_file", {
    path: "nested/change.txt",
    old_text: "line 1\n",
    new_text: "changed line 1\n",
  }, context);
  await nextTurn();
  state.tui.focusedComponent.handleInput("\u001b");
  assert.equal(await replace, "Permission denied by user.");
  assert.match(await readFile(path.join(workspace, "nested/change.txt"), "utf8"), /^line 1/);
});

test("plan approval supports approve, reject, revise, and focus restoration", async (t) => {
  const ui = createTui();
  const state = internals(ui);
  t.after(() => state.tui.stop());

  let decision = ui.reviewPlan("1. Change file", ".jevio/plans/plan.md");
  assert.equal(state.tui.focusedComponent.getSelectedItem?.()?.value, "approve");
  state.tui.focusedComponent.handleInput("\n");
  assert.deepEqual(await decision, { decision: "approve" });
  assert.equal(state.tui.hasOverlay(), false);

  decision = ui.reviewPlan("1. Change file", ".jevio/plans/plan.md");
  state.tui.focusedComponent.handleInput("\u001b");
  assert.deepEqual(await decision, { decision: "reject" });
  assert.equal(state.tui.hasOverlay(), false);

  decision = ui.reviewPlan("1. Change file", ".jevio/plans/plan.md");
  state.tui.focusedComponent.handleInput("\u001b[B");
  state.tui.focusedComponent.handleInput("\u001b[B");
  state.tui.focusedComponent.handleInput("\n");
  state.tui.focusedComponent.handleInput("Add a regression test");
  state.tui.focusedComponent.handleInput("\n");
  assert.deepEqual(await decision, { decision: "revise", feedback: "Add a regression test" });
  assert.equal(state.tui.hasOverlay(), false);
});

test("thinking collapse survives finalize and Ctrl+O toggles it", () => {
  const ui = createTui();
  const state = internals(ui);
  state.tui.stop();

  ui.reportEvent({ type: "thinking_delta", role: "coder", detail: "line one\n" });
  ui.reportEvent({ type: "thinking_delta", role: "coder", detail: "line two\nline three\n" });
  assert.equal(state.thinkingBlocks.length, 1);
  assert.equal(state.thinkingBlocks[0].streaming, true);

  ui.reportEvent({ type: "thinking_done", role: "coder", detail: "" });
  assert.equal(state.thinkingBlocks[0].streaming, false);
  assert.equal(state.thinkingBlocks[0].expanded, false);

  // After finalize, Ctrl+O still toggles the collapsed block.
  state.tui.handleInput("\x0f");
  assert.equal(state.thinkingBlocks[0].expanded, true);
  state.tui.handleInput("\x0f");
  assert.equal(state.thinkingBlocks[0].expanded, false);
});

test("tool events edit one live activity panel and stay expandable after freeze", () => {
  const ui = createTui();
  const state = internals(ui);
  state.tui.stop();

  const childrenBefore = state.transcript.children.length;
  ui.reportEvent({ type: "tool", role: "coder", detail: "read_file (running) src/cli.ts" });
  const afterFirst = state.transcript.children.length;
  // heading + body + spacer
  assert.equal(afterFirst - childrenBefore, 3);
  assert.equal(state.liveActivity?.tools.length, 1);
  assert.equal(state.liveActivity?.tools[0].status, "running");
  assert.match(transcriptText(ui), /read_file/);

  ui.reportEvent({ type: "tool", role: "coder", detail: "read_file (done) src/cli.ts → 40 lines" });
  // Still the same 3 children — only setText on the panel.
  assert.equal(state.transcript.children.length, afterFirst);
  assert.equal(state.liveActivity?.tools[0].status, "done");
  assert.match(transcriptText(ui), /40 lines/);

  ui.reportEvent({ type: "tool", role: "coder", detail: "write_file (running) src/foo.ts" });
  ui.reportEvent({ type: "progress", role: "coder", detail: "Пишу файл" });
  assert.equal(state.transcript.children.length, afterFirst);
  assert.equal(state.liveActivity?.tools.length, 2);
  assert.match(transcriptText(ui), /write_file/);
  assert.match(transcriptText(ui), /Пишу файл/);

  state.freezeLiveActivity();
  assert.equal(state.liveActivity, undefined);
  assert.equal(state.activityBlocks.length, 1);
  assert.equal(state.activityBlocks[0].frozen, true);
  assert.equal(state.activityBlocks[0].expanded, false);
  // Collapsed by default — summary in heading, body empty.
  assert.equal(state.transcript.children.length, afterFirst);
  assert.match(transcriptText(ui), /2 tools/);

  // Ctrl+O expands frozen activity and shows tool rows again.
  state.tui.handleInput("\x0f");
  assert.equal(state.activityBlocks[0].expanded, true);
  assert.match(transcriptText(ui), /read_file/);
  assert.match(transcriptText(ui), /write_file/);

  // Ctrl+W collapses all.
  state.tui.handleInput("\x17");
  assert.equal(state.activityBlocks[0].expanded, false);
});

test("parseToolEventDetail and tool summaries extract useful meta", () => {
  assert.deepEqual(parseToolEventDetail("read_file (running) src/a.ts"), {
    name: "read_file",
    status: "running",
    meta: "src/a.ts",
  });
  assert.deepEqual(parseToolEventDetail("run_command (failed) npm test → exit 1"), {
    name: "run_command",
    status: "failed",
    meta: "npm test → exit 1",
  });
  assert.equal(summarizeToolCall("write_file", { path: "src/x.ts" }), "src/x.ts");
  assert.equal(summarizeToolCall("search_text", { query: "needle", path: "src" }), '"needle" in src');
  assert.equal(summarizeToolResult("read_file", "1: a\n2: b\n3: c"), "3 lines");
  assert.equal(summarizeToolResult("run_command", "exit: 0\nstdout:\nok"), "exit 0");
  assert.match(
    formatActivityBody([
      { name: "read_file", role: "coder", status: "done", meta: "a.ts", startedAt: 0, elapsedMs: 12 },
      { name: "write_file", role: "coder", status: "running", meta: "b.ts", startedAt: 0 },
    ], "almost done"),
    /✓ CODER {2}read_file · 12ms {2}a\.ts/,
  );
  assert.match(
    formatActivitySummary([
      { name: "read_file", role: "coder", status: "done", meta: "a.ts", startedAt: 0, elapsedMs: 12 },
      { name: "write_file", role: "coder", status: "done", meta: "b.ts", startedAt: 0, elapsedMs: 40 },
    ], 1200),
    /2 tools · 1\.2s · read_file → write_file/,
  );
});
