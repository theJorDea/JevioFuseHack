import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../src/agent.ts";
import type { ToolContext } from "../src/types.ts";

const context: ToolContext = {
  workspace: process.cwd(),
  skills: [],
  projectCodeMap: "src/\n  auth.ts\n    class AuthService",
  autoApproveWrites: false,
  autoApproveShell: false,
  confirm: async () => false,
};

test("repository map is injected only for planning roles", () => {
  const orchestratorPrompt = buildSystemPrompt("orchestrator", context);
  assert.match(orchestratorPrompt, /You are Fuse/);
  assert.match(orchestratorPrompt, /suggest_mode/);
  assert.match(orchestratorPrompt, /<repository_map>/);
  assert.match(buildSystemPrompt("architect", context), /AuthService/);
  assert.match(buildSystemPrompt("judge", context), /AuthService/);
  assert.doesNotMatch(buildSystemPrompt("coder", context), /<repository_map>/);
  assert.doesNotMatch(buildSystemPrompt("reviewer", context), /<repository_map>/);
});
