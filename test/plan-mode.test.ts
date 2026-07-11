import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeTool, isPlanModeBlocking, toolsForRole } from "../src/tools.ts";
import type { PlanModeState, ToolContext } from "../src/types.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-plan-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function baseContext(root: string, planMode?: PlanModeState): ToolContext {
  return {
    workspace: root,
    skills: [],
    autoApproveWrites: true,
    autoApproveShell: true,
    shellMode: "full",
    confirm: async () => true,
    planMode,
  };
}

test("plan tools are available to orchestrator, architect, and coder", () => {
  for (const role of ["orchestrator", "architect", "coder"] as const) {
    const names = toolsForRole(role).map((tool) => tool.function.name);
    assert.ok(names.includes("enter_plan_mode"), role);
    assert.ok(names.includes("exit_plan_mode"), role);
    assert.ok(names.includes("submit_plan"), role);
  }
  assert.ok(!toolsForRole("reviewer").some((tool) => tool.function.name === "enter_plan_mode"));
});

test("enter/exit/submit plan mode tools drive host callbacks", async (t) => {
  const root = await workspace(t);
  const planMode: PlanModeState = { active: false };
  const events: string[] = [];
  const context: ToolContext = {
    ...baseContext(root, planMode),
    enterPlanMode: async (goal) => {
      planMode.active = true;
      planMode.goal = goal;
      events.push(`enter:${goal ?? ""}`);
      return "entered";
    },
    exitPlanMode: async (reason) => {
      planMode.active = false;
      events.push(`exit:${reason ?? ""}`);
      return "exited";
    },
    submitPlan: async (plan) => {
      planMode.approvedPlan = plan;
      planMode.active = false;
      events.push(`submit:${plan.slice(0, 20)}`);
      return "approved";
    },
  };

  assert.equal(await executeTool("enter_plan_mode", { goal: "Auth redesign" }, context), "entered");
  assert.equal(planMode.active, true);
  assert.equal(planMode.goal, "Auth redesign");
  assert.equal(await executeTool("exit_plan_mode", { reason: "cancelled" }, context), "exited");
  assert.equal(planMode.active, false);

  planMode.active = true;
  assert.equal(await executeTool("submit_plan", { plan: "1. Touch src/auth.ts\n2. Add tests" }, context), "approved");
  assert.deepEqual(events, [
    "enter:Auth redesign",
    "exit:cancelled",
    "submit:1. Touch src/auth.ts",
  ]);
});

test("plan mode blocks writes, package shell, and coder delegation", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "a.txt"), "old");
  const planMode: PlanModeState = { active: true, goal: "safe plan" };
  let delegated = "";
  const context: ToolContext = {
    ...baseContext(root, planMode),
    delegate: async (role, task) => {
      delegated = `${role}:${task}`;
      return "ok";
    },
  };

  assert.equal(isPlanModeBlocking("write_file", context), true);
  assert.match(await executeTool("write_file", { path: "a.txt", content: "new" }, context), /Blocked by Plan Mode/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old");
  assert.match(
    await executeTool("run_command", { command: "npm install" }, context),
    /Blocked by Plan Mode/,
  );
  assert.match(
    await executeTool("delegate_agent", { role: "coder", task: "edit files" }, context),
    /Blocked by Plan Mode/,
  );
  assert.equal(delegated, "");
  assert.equal(
    await executeTool("delegate_agent", { role: "architect", task: "map flow" }, context),
    "ok",
  );
  assert.equal(delegated, "architect:map flow");
});

test("submit_plan auto-enters plan mode when inactive", async () => {
  const planMode: PlanModeState = { active: false };
  let entered = false;
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
    planMode,
    enterPlanMode: async () => {
      planMode.active = true;
      entered = true;
      return "entered";
    },
    submitPlan: async (plan) => `got:${plan}`,
  };
  assert.equal(await executeTool("submit_plan", { plan: "Do X then Y" }, context), "got:Do X then Y");
  assert.equal(entered, true);
});
