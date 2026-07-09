import assert from "node:assert/strict";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendProjectMemory,
  appendSessionCompaction,
  appendSessionTurn,
  clearProjectMemory,
  createSession,
  discardEmptySession,
  exportSession,
  forkSession,
  listSessions,
  loadProjectMemory,
  loadSession,
  renameSession,
} from "../src/session.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-session-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Markdown sessions support append, resume, rename, fork, and export", async (t) => {
  const root = await workspace(t);
  const session = await createSession(root);
  await renameSession(session, "Parser work");
  await appendSessionTurn(session, "Fix parsing", "Implemented and tested.");

  const sessions = await listSessions(root);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Parser work");
  assert.equal(sessions[0].messageCount, 2);

  const loaded = await loadSession(root, session.id.slice(0, 12));
  assert.deepEqual(loaded.history.map((message) => message.content), [
    "Fix parsing",
    "Implemented and tested.",
  ]);

  const fork = await forkSession(root, session);
  assert.equal(fork.history.length, 2);
  assert.match(fork.info.title, /fork/);
  assert.notEqual(fork.info.id, session.id);

  const exported = await exportSession(session, path.join(root, "exports"));
  assert.match(await readFile(exported, "utf8"), /Implemented and tested/);
});

test("project memory is readable Markdown and can be cleared", async (t) => {
  const root = await workspace(t);
  const file = await appendProjectMemory(root, "Always run the parser regression tests.");
  assert.match(await readFile(file, "utf8"), /Always run the parser regression tests/);
  assert.match(await loadProjectMemory(root), /^# Jevio Project Memory/);
  await clearProjectMemory(root);
  assert.equal(await loadProjectMemory(root), "# Jevio Project Memory\n");
});

test("resume starts from the latest compaction checkpoint", async (t) => {
  const root = await workspace(t);
  const session = await createSession(root, "Long task");
  await appendSessionTurn(session, "old request", "old answer");
  await appendSessionTurn(session, "recent request", "recent answer");
  const retained = [
    { role: "user" as const, content: "recent request" },
    { role: "assistant" as const, content: "recent answer" },
  ];
  await appendSessionCompaction(session, "The old request is complete.", retained);
  await appendSessionTurn(session, "next request", "next answer");

  const loaded = await loadSession(root, session.id);
  const contents = loaded.history.map((message) => String(message.content));
  assert.match(contents[0], /old request is complete/);
  assert.equal(contents.includes("old request"), false);
  assert.deepEqual(contents.slice(-4), ["recent request", "recent answer", "next request", "next answer"]);
});

test("empty sessions are removed", async (t) => {
  const root = await workspace(t);
  const session = await createSession(root);
  await discardEmptySession(session);
  await assert.rejects(() => access(session.path));
});
