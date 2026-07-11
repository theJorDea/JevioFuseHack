import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  formatKairosReport,
  gatherKairosSignals,
  runKairos,
  shouldAutoKairos,
} from "../src/kairos.ts";
import { appendSessionTurn, createSession, writeProjectMemory } from "../src/session.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-kairos-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("gatherKairosSignals reports empty memory and sessions", async (t) => {
  const root = await workspace(t);
  const observation = await gatherKairosSignals(root);
  assert.ok(observation.signals.some((signal) => signal.id === "empty-memory" || signal.id === "no-sessions"));
  assert.match(observation.summary, /KAIROS/);
  assert.ok(shouldAutoKairos(observation, { minSeverity: "watch" }));
});

test("kairos notices pending dream queue after session work", async (t) => {
  const root = await workspace(t);
  await writeProjectMemory(root, "# Memory\n\n- keep auth simple\n");
  const session = await createSession(root, "Feature work");
  for (let index = 0; index < 6; index += 1) {
    await appendSessionTurn(session, `step ${index}`, `done ${index}`);
  }
  const observation = await gatherKairosSignals(root);
  assert.ok(observation.signals.some((signal) => signal.id === "pending-dream"));
  assert.ok(observation.raw.pendingDreamSessions >= 1);
  const report = formatKairosReport(observation, "- Проверь diff и /dream");
  assert.match(report, /pending-dream|Очередь на \/dream|Синтез/i);
  assert.match(report, /\/dream/);
});

test("runKairos can skip model synthesis", async (t) => {
  const root = await workspace(t);
  let called = false;
  const result = await runKairos({
    workspace: root,
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: {
      workspace: root,
      skills: [],
      autoApproveWrites: false,
      autoApproveShell: false,
      confirm: async () => false,
    },
    synthesize: false,
    runner: async () => {
      called = true;
      return { content: "should not run", role: "compactor", turns: 1 };
    },
  });
  assert.equal(called, false);
  assert.ok(result.signals.length >= 1);
  assert.equal(result.synthesis, undefined);
});

test("runKairos optional synthesis uses compactor", async (t) => {
  const root = await workspace(t);
  const result = await runKairos({
    workspace: root,
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: {
      workspace: root,
      skills: [],
      autoApproveWrites: false,
      autoApproveShell: false,
      confirm: async () => false,
    },
    synthesize: true,
    runner: async (options) => {
      assert.equal(options.role, "compactor");
      assert.match(options.task, /KAIROS/);
      return { content: "- Запусти /dream\n- Проверь git status", role: "compactor", turns: 1 };
    },
  });
  assert.match(result.synthesis ?? "", /\/dream/);
});

test("shouldAutoKairos respects severity threshold", () => {
  assert.equal(shouldAutoKairos({
    signals: [{ id: "x", severity: "info", title: "i", detail: "d" }],
    raw: {
      gitStatus: "",
      gitDiffStat: "",
      uncommittedCount: 0,
      memoryCharacters: 0,
      pendingDreamSessions: 0,
      recentSessions: [],
    },
    summary: "ok",
    observedAt: new Date().toISOString(),
  }, { minSeverity: "watch" }), false);
  assert.equal(shouldAutoKairos({
    signals: [{ id: "x", severity: "action", title: "a", detail: "d" }],
    raw: {
      gitStatus: "",
      gitDiffStat: "",
      uncommittedCount: 0,
      memoryCharacters: 0,
      pendingDreamSessions: 0,
      recentSessions: [],
    },
    summary: "act",
    observedAt: new Date().toISOString(),
  }, { minSeverity: "watch" }), true);
});
