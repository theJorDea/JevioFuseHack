import assert from "node:assert/strict";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendProjectMemory,
  appendSessionCouncil,
  appendSessionCompaction,
  appendSessionTurn,
  clearProjectMemory,
  createSession,
  discardEmptySession,
  exportSession,
  forkSession,
  listSessions,
  loadProjectMemory,
  loadLatestCouncilReview,
  loadSession,
  replaceProjectMemory,
  renameSession,
  saveSessionTodos,
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
  await appendSessionTurn(session, "Marker <!-- jevio:message role=user -->", "Answer <!-- /jevio:message -->");
  await saveSessionTodos(session, [
    { content: "Inspect parser", status: "completed" },
    { content: "Add regression test", status: "in_progress" },
  ]);

  const sessions = await listSessions(root);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Parser work");
  assert.equal(sessions[0].messageCount, 4);

  const loaded = await loadSession(root, session.id.slice(0, 12));
  assert.deepEqual(loaded.history.slice(0, 2).map((message) => message.content), [
    "Fix parsing",
    "Implemented and tested.",
  ]);
  assert.deepEqual(loaded.history.slice(-2).map((message) => message.content), [
    "Marker <!-- jevio:message role=user -->",
    "Answer <!-- /jevio:message -->",
  ]);
  assert.deepEqual(loaded.todos, [
    { content: "Inspect parser", status: "completed" },
    { content: "Add regression test", status: "in_progress" },
  ]);

  const fork = await forkSession(root, session);
  assert.equal(fork.history.length, 4);
  assert.deepEqual(fork.history.slice(-2).map((message) => message.content), [
    "Marker <!-- jevio:message role=user -->",
    "Answer <!-- /jevio:message -->",
  ]);
  assert.deepEqual(fork.todos, loaded.todos);
  assert.match(fork.info.title, /fork/);
  assert.notEqual(fork.info.id, session.id);

  const exported = await exportSession(session, path.join(root, "exports"));
  assert.match(await readFile(exported, "utf8"), /Implemented and tested/);
});

test("Council review records survive compaction and expose the latest verdict", async (t) => {
  const root = await workspace(t);
  const session = await createSession(root);
  await appendSessionTurn(session, "Review", "Started.");
  await appendSessionCouncil(session, "review", "# Council Review\n\n## Verdict\n\nFIX");
  await appendSessionCompaction(session, "Review is pending.", [{ role: "user", content: "Review" }, { role: "assistant", content: "Started." }]);
  assert.match(await loadLatestCouncilReview(session) ?? "", /Council Review/);
});

test("session prefixes must identify one session", async (t) => {
  const root = await workspace(t);
  await createSession(root);
  await createSession(root);
  await assert.rejects(() => loadSession(root, "2"), /ambiguous/);
});

test("project memory is readable Markdown and can be cleared", async (t) => {
  const root = await workspace(t);
  const file = await appendProjectMemory(root, "Always run the parser regression tests.");
  assert.match(await readFile(file, "utf8"), /Always run the parser regression tests/);
  assert.match(await loadProjectMemory(root), /^# Jevio Project Memory/);
  await clearProjectMemory(root);
  assert.equal(await loadProjectMemory(root), "# Jevio Project Memory\n");
});

test("project memory replacement removes the stale text and records its provenance link", async (t) => {
  const root = await workspace(t);
  await appendProjectMemory(root, "Use timeout 10 seconds.");
  const file = await replaceProjectMemory(root, "Use timeout 10 seconds.", "Use timeout 60 seconds.", "old-record");
  const document = await readFile(file, "utf8");
  assert.doesNotMatch(document, /10 seconds/);
  assert.match(document, /60 seconds[\s\S]*Replaces memory record `old-record`/);
});

test("memory append preserves content beyond the read limit", async (t) => {
  const root = await workspace(t);
  const largeEntry = "x".repeat(40_050);
  await appendProjectMemory(root, largeEntry);
  await appendProjectMemory(root, "Keep this tail.");
  const document = await readFile(path.join(root, ".jevio", "MEMORY.md"), "utf8");
  assert.equal(document.includes(largeEntry), true);
  assert.match(document, /Keep this tail\./);
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
  const compactedDocument = await readFile(session.path, "utf8");
  assert.equal(compactedDocument.includes("old answer"), false);
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
