import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runCouncilPlan, runCouncilReview, runTeam } from "../src/orchestrator.ts";
import type { ChatMessage, ToolContext } from "../src/types.ts";

test("team mode forwards session history to every specialist", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "Earlier task" },
    { role: "assistant", content: "Earlier result" },
  ];
  const calls: Array<{ role: string; history?: ChatMessage[] }> = [];
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  const result = await runTeam({
    task: "Follow-up task",
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: context,
    history,
    runner: async (options) => {
      calls.push({ role: options.role, history: options.history });
      const content = options.role === "architect"
        ? "Plan"
        : options.role === "reviewer"
          ? "<verdict>PASS</verdict>"
          : "Implementation";
      return { content, turns: 1, history: [] };
    },
  });

  assert.equal(result.content, "Implementation");
  assert.deepEqual(calls.map((call) => call.role), ["architect", "coder", "reviewer"]);
  for (const call of calls) assert.strictEqual(call.history, history);
});

test("council plan selects a plan before one coder changes the workspace", async () => {
  const calls: string[] = [];
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  const result = await runCouncilPlan({
    task: "Refactor session storage",
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: context,
    runner: async (options) => {
      calls.push(options.role);
      const content = options.role === "reviewer"
        ? "<verdict>PASS</verdict>"
        : `${options.role} report`;
      return { content, turns: 1, history: [] };
    },
  });

  assert.deepEqual(calls, ["architect", "architect", "architect", "judge", "coder", "reviewer"]);
  assert.equal(result.architectPlans.length, 3);
  assert.equal(result.plan, "judge report");
  assert.equal(result.content, "coder report");
});

test("council planning limits concurrent read-only architects", async () => {
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    confirm: async () => false,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.agent.maxParallelReadAgents = 3;
  let activeArchitects = 0;
  let peakArchitects = 0;
  await runCouncilPlan({
    task: "Plan a change",
    config,
    toolContext: context,
    runner: async (options) => {
      if (options.role === "architect") {
        activeArchitects += 1;
        peakArchitects = Math.max(peakArchitects, activeArchitects);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeArchitects -= 1;
      }
      return {
        content: options.role === "reviewer" ? "<verdict>PASS</verdict>" : `${options.role} report`,
        turns: 1,
        history: [],
      };
    },
  });

  assert.equal(peakArchitects, 3);
});

test("council review combines three focused reports into a judge verdict", async () => {
  const calls: string[] = [];
  const approvalModes: boolean[] = [];
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: true,
    autoApproveShell: true,
    confirm: async () => false,
  };
  const result = await runCouncilReview({
    task: "Review current changes",
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: context,
    runner: async (options) => {
      calls.push(options.role);
      approvalModes.push(options.toolContext.autoApproveShell || options.toolContext.autoApproveWrites);
      return {
        content: options.role === "judge" ? "Looks good\n<verdict>PASS</verdict>" : "No finding\n<verdict>PASS</verdict>",
        turns: 1,
        history: [],
      };
    },
  });

  assert.deepEqual(calls, ["reviewer", "reviewer", "reviewer", "judge"]);
  assert.deepEqual(approvalModes, [false, false, false, false]);
  assert.equal(result.verdict, "PASS");
  assert.match(result.content, /^Вердикт: PASS/);
});
