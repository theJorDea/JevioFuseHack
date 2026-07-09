import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompactedHistory,
  compactConversation,
  estimateHistoryTokens,
  fitCompactedHistory,
  historyCharacters,
  needsAutoCompaction,
} from "../src/compaction.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ChatMessage } from "../src/types.ts";

function messages(count: number, size = 20): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(size),
  }));
}

test("compaction preserves a summary and exact recent messages", () => {
  const recent = messages(4);
  const compacted = buildCompactedHistory("Files changed: src/a.ts", recent);
  assert.equal(compacted.length, 6);
  assert.match(String(compacted[0].content), /src\/a\.ts/);
  assert.deepEqual(compacted.slice(-4), recent);
});

test("auto compaction uses token reserve and character fallback", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.compaction.contextWindowTokens = 100;
  config.compaction.reservedTokens = 20;
  config.compaction.triggerCharacters = 100_000;
  config.compaction.keepRecentMessages = 2;
  const history = messages(8, 600);
  assert.ok(estimateHistoryTokens(history) >= 80);
  assert.equal(needsAutoCompaction(history, config), true);
  config.compaction.auto = false;
  assert.equal(needsAutoCompaction(history, config), false);
  assert.equal(historyCharacters(history), 4800);
});

test("auto compaction includes static memory and the next request", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.compaction.contextWindowTokens = 2_000;
  config.compaction.reservedTokens = 500;
  config.compaction.triggerCharacters = 100_000;
  config.compaction.keepRecentMessages = 2;
  const history = messages(6, 100);
  assert.equal(needsAutoCompaction(history, config), false);
  assert.equal(needsAutoCompaction(history, config, "важный контекст ".repeat(200)), true);
});

test("fitted compaction drops retained turns until context is smaller", () => {
  const source = messages(10, 200);
  const fitted = fitCompactedHistory("Dense summary ".repeat(20), source, 10);
  assert.ok(estimateHistoryTokens(fitted.history) < estimateHistoryTokens(source));
  assert.ok(fitted.retainedMessages.length < source.length);
  assert.throws(
    () => fitCompactedHistory("summary ".repeat(10_000), source, 0),
    /did not reduce/,
  );
});

test("model-driven compaction uses the dedicated role and custom instruction", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.compaction.keepRecentMessages = 2;
  let receivedTask = "";
  const result = await compactConversation({
    history: messages(8, 500),
    config,
    toolContext: {
      workspace: process.cwd(),
      skills: [],
      autoApproveWrites: false,
      autoApproveShell: false,
      confirm: async () => false,
    },
    instruction: "Keep database migration details",
    runner: async (options) => {
      assert.equal(options.role, "compactor");
      assert.equal(options.maxTurns, 1);
      receivedTask = options.task;
      return { content: "Database migration remains pending.", turns: 1, history: [] };
    },
  });
  assert.match(receivedTask, /database migration details/);
  assert.match(result.summary, /remains pending/);
  assert.ok(estimateHistoryTokens(result.history) < estimateHistoryTokens(messages(8, 500)));
});
