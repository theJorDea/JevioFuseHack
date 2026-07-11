import assert from "node:assert/strict";
import test from "node:test";
import { formatCritiqueAppendix, parseCritiqueVerdict, runCritique } from "../src/critique.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentResult, ToolContext } from "../src/types.ts";

test("parseCritiqueVerdict reads markers and heuristics", () => {
  assert.equal(parseCritiqueVerdict("ok\n<verdict>PASS</verdict>"), "PASS");
  assert.equal(parseCritiqueVerdict("needs work\n<verdict>IMPROVE</verdict>"), "IMPROVE");
  assert.equal(parseCritiqueVerdict("bad\n<verdict>FIX</verdict>"), "FIX");
  assert.equal(parseCritiqueVerdict("There is a critical security issue"), "FIX");
  assert.equal(parseCritiqueVerdict("Optional: consider caching"), "IMPROVE");
});

test("formatCritiqueAppendix includes next steps", () => {
  const text = formatCritiqueAppendix({
    content: "### Critical\nNone.",
    verdict: "IMPROVE",
    turns: 2,
  });
  assert.match(text, /Code critique/);
  assert.match(text, /IMPROVE/);
  assert.match(text, /\/critique fix/);
  assert.match(text, /\/council-review/);
});

test("runCritique uses reviewer role and maps verdict", async () => {
  const calls: string[] = [];
  const context: ToolContext = {
    workspace: process.cwd(),
    skills: [],
    autoApproveWrites: true,
    autoApproveShell: false,
    confirm: async () => true,
  };
  const result = await runCritique({
    config: DEFAULT_CONFIG,
    toolContext: context,
    userRequest: "Add a login form",
    runner: async (options) => {
      calls.push(options.role);
      assert.equal(options.role, "reviewer");
      assert.match(options.task, /git_diff|code critic/i);
      assert.equal(options.toolContext.autoApproveWrites, false);
      const agent: AgentResult & { history: [] } = {
        content: "### Critical\n- bug\n<verdict>FIX</verdict>",
        turns: 3,
        history: [],
      };
      return agent;
    },
  });
  assert.deepEqual(calls, ["reviewer"]);
  assert.equal(result.verdict, "FIX");
  assert.match(result.content, /bug/);
});
