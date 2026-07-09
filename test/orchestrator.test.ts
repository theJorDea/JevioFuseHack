import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runTeam } from "../src/orchestrator.ts";
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
