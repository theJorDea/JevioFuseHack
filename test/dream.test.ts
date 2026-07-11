import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  dreamStatus,
  gatherDreamSignals,
  loadDreamState,
  pendingDreamWork,
  runDream,
  saveDreamState,
} from "../src/dream.ts";
import {
  appendSessionTurn,
  createSession,
  loadProjectMemory,
  writeProjectMemory,
} from "../src/session.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-dream-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("pending dream work counts only unseen session messages", () => {
  const pending = pendingDreamWork(
    [
      { id: "a", title: "A", path: "a.md", createdAt: "1", updatedAt: "2", messageCount: 4 },
      { id: "b", title: "B", path: "b.md", createdAt: "1", updatedAt: "3", messageCount: 2 },
    ],
    { version: 1, sessions: { a: 2 } },
  );
  assert.equal(pending.length, 2);
  assert.equal(pending[0].session.id, "b");
  assert.equal(pending.find((item) => item.session.id === "a")?.newMessages, 2);
});

test("gather and status track undreamed session signals", async (t) => {
  const root = await workspace(t);
  const session = await createSession(root, "Auth work");
  await appendSessionTurn(session, "Use JWT", "Added token middleware in src/auth.ts");
  await appendSessionTurn(session, "Prefer HS256", "Updated signing to HS256");

  const gathered = await gatherDreamSignals(root);
  assert.equal(gathered.skippedEmpty, false);
  assert.equal(gathered.signals.length, 1);
  assert.match(gathered.signals[0].excerpt, /JWT/);
  assert.match(gathered.signals[0].excerpt, /HS256/);

  const status = await dreamStatus(root);
  assert.equal(status.pendingSessions, 1);
  assert.equal(status.pendingMessages, 4);
  assert.match(status.detail, /Ожидает сна/);
});

test("runDream consolidates MEMORY.md and advances dream state", async (t) => {
  const root = await workspace(t);
  await writeProjectMemory(root, "# Jevio Project Memory\n\n- Old note\n");
  const session = await createSession(root, "DB work");
  await appendSessionTurn(session, "Use Postgres", "Chose Postgres for durable storage");

  let receivedTask = "";
  const result = await runDream({
    workspace: root,
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: {
      workspace: root,
      skills: [],
      autoApproveWrites: false,
      autoApproveShell: false,
      confirm: async () => false,
    },
    runner: async (options) => {
      receivedTask = options.task;
      const historyText = (options.history ?? []).map((message) => String(message.content ?? "")).join("\n");
      assert.match(historyText, /Postgres/);
      assert.match(historyText, /Old note/);
      return {
        content: `# Jevio Project Memory

## Stack
- Postgres for durable storage
- Prefer JWT HS256 when auth is needed
`,
        role: "compactor" as const,
        turns: 1,
      };
    },
  });

  assert.match(receivedTask, /Consolidate durable project memory/i);
  assert.equal(result.sessionsProcessed, 1);
  assert.ok(result.newMessages >= 2);
  const memory = await loadProjectMemory(root);
  assert.match(memory, /Postgres/);
  assert.match(memory, /JWT/);

  const state = await loadDreamState(root);
  assert.ok(state.lastDreamedAt);
  assert.equal(state.sessions[session.id], session.messageCount);

  const status = await dreamStatus(root);
  assert.equal(status.pendingSessions, 0);
  assert.match(status.detail, /нет новых сообщений/i);

  // Second dream without new work should fail unless force.
  await assert.rejects(
    () => runDream({
      workspace: root,
      config: structuredClone(DEFAULT_CONFIG),
      toolContext: {
        workspace: root,
        skills: [],
        autoApproveWrites: false,
        autoApproveShell: false,
        confirm: async () => false,
      },
      runner: async () => ({ content: "# x", role: "compactor", turns: 1 }),
    }),
    /Нечего консолидировать/,
  );

  const forced = await runDream({
    workspace: root,
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: {
      workspace: root,
      skills: [],
      autoApproveWrites: false,
      autoApproveShell: false,
      confirm: async () => false,
    },
    force: true,
    runner: async () => ({
      content: "# Jevio Project Memory\n\n- Compact durable facts only\n",
      role: "compactor",
      turns: 1,
    }),
  });
  assert.match(forced.memory, /Compact durable facts/);
  assert.match(await readFile(path.join(root, ".jevio", "MEMORY.md"), "utf8"), /Compact durable facts/);
});

test("saveDreamState round-trips session checkpoints", async (t) => {
  const root = await workspace(t);
  await saveDreamState(root, {
    version: 1,
    lastDreamedAt: "2026-01-01T00:00:00.000Z",
    sessions: { "session-1": 6 },
  });
  const loaded = await loadDreamState(root);
  assert.equal(loaded.lastDreamedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(loaded.sessions["session-1"], 6);
});
