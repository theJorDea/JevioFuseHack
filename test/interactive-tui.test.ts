import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { InteractiveTui } from "../src/interactive-tui.ts";
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
    listProviders: async () => [],
    selectProvider: async () => "",
    addProvider: async () => "",
    listRoleConfigs: async () => [],
    listPlugins: async () => "MCP-плагины не настроены.",
    configureRole: async () => "",
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
};

function internals(ui: InteractiveTui): TuiInternals {
  return ui as unknown as TuiInternals;
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
