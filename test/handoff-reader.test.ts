import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readHandoffEvidence } from "../src/handoff-reader.ts";

const assistant = (...blocks: unknown[]) => ({ type: "assistant", message: { role: "assistant", content: blocks } });
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const edit = (id: string) => ({ type: "tool_use", id, name: "Edit", input: { file_path: "SECRET", new_string: "SECRET" } });
const result = (key: string, err = false) => ({ type: "tool_result", tool_use_id: key, is_error: err, content: "SECRET stdout: exit code 0" });
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jevio-artificial-"))), file = path.join(root, "synthetic.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  return async (...rows: (object | string)[]) => {
    await writeFile(file, rows.map(row => typeof row === "string" ? row : JSON.stringify({ cwd: root, sessionId: "mock", ...row })).join("\n"));
    return readHandoffEvidence(file, root);
  };
}

test("links interleaved results by ID; returns only allowlisted labels and source lines", async t => {
  const read = await fixture(t);
  assert.deepEqual(await read(user("SECRET goal"), assistant(bash("a", "pytest SECRET/path"), edit("b")), user([result("b")]),
    { ...user([result("a", true)]), toolUseResult: { exitCode: 1 } }, assistant(bash("c", "npm test")),
    { ...user([result("c")]), toolUseResult: { exitCode: 0 } }), {
    partial: false, checks: [
      { label: "pytest", callLine: 2, resultLine: 4, outcome: "FAIL", exitCode: 1 },
      { label: "npm test", callLine: 5, resultLine: 6, outcome: "PASS", exitCode: 0 },
    ], edits: [3], goalLine: 1,
  });
});

test("pytest accepts a literal -k without exporting it, but not shell expressions", async t => {
  const read = await fixture(t);
  const e = await read(assistant(bash("a", "pytest tests/test_private.py -k SECRET"), bash("b", "pytest -k SECRET && true")),
    { ...user([result("a")]), toolUseResult: { exitCode: 0 } }, { ...user([result("b")]), toolUseResult: { exitCode: 0 } });
  assert.deepEqual(e.checks.map(c => [c.label, c.outcome]), [["pytest", "PASS"], ["pytest", "UNKNOWN"]]);
  assert.doesNotMatch(JSON.stringify(e), /SECRET|test_private/);
});

test("refuses junction/symlink ancestors and noncanonical transcript cwd", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jevio-link-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "real"), alias = path.join(root, "link"), file = path.join(directory, "mock.jsonl");
  await mkdir(directory);
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(file, JSON.stringify({ cwd: directory, ...user("goal") }));
  await assert.rejects(readHandoffEvidence(path.join(alias, "mock.jsonl"), directory), /unreadable local transcript/);
  for (const cwd of [alias, `${directory}${path.sep}.`, String.raw`\\untrusted.invalid\share`]) {
    await writeFile(file, JSON.stringify({ cwd, ...user("goal") }));
    await assert.rejects(readHandoffEvidence(file, directory), /unreadable local transcript/);
  }
});

test("unclosed, compound, ambiguous multi-result and stdout-only checks are not passes", async t => {
  const read = await fixture(t);
  const evidence = await read(assistant(bash("x", "pytest SECRET || true"), bash("y", "go test"), bash("z", "cargo test"), bash("u", "node --test"), bash("v", "pytest"), bash("other", "SECRET")),
    { ...user([result("x")]), toolUseResult: { exitCode: 0 } }, user([result("y")]),
    { ...user([result("z"), result("u")]), toolUseResult: { exitCode: 0 } }, "{unfinished");
  assert.equal(evidence.partial, true);
  assert.deepEqual(evidence.checks.map(c => [c.label, c.outcome, c.exitCode, c.resultLine]), [
    ["pytest", "UNKNOWN", null, 2], ["go test", "UNKNOWN", null, 3], ["cargo test", "UNKNOWN", null, 4], ["node --test", "UNKNOWN", null, 4], ["pytest", "UNKNOWN", null, null],
  ]);
  assert.ok(!JSON.stringify(evidence).includes("SECRET"));
});

test("fork discards both alternatives; failed or ambiguous edits not reported", async t => {
  const read = await fixture(t);
  const root = { uuid: "root", parentUuid: null, ...user("goal") };
  const fork = await read(root, { uuid: "first", parentUuid: "root", ...assistant(edit("a")) },
    { uuid: "result", parentUuid: "first", ...user([result("a")]) },
    { uuid: "other", parentUuid: "root", ...assistant(bash("a", "npm test")) });
  assert.deepEqual(fork, { partial: true, goalLine: 1, edits: [], checks: [], coverage: { unknown: 0, damaged: 0, unmatched: 1 } });
  const bad = await read(assistant(edit("x"), edit("y")), user([result("x", true), result("y")]), user([result("y")]));
  assert.deepEqual(bad.edits, []);
  assert.equal(bad.partial, true);
});

test("conflicting, absent or unsupported identity/format produce no evidence or path disclosure", async t => {
  const read = await fixture(t);
  for (const rows of [[{ ...user("x"), cwd: null }], [user("x"), { ...user("x"), cwd: os.tmpdir() }],
    [user("x"), { ...user("x"), sessionId: "SECRET" }], [{ type: "future-format", value: "SECRET" }],
    [user("x"), "x".repeat(1024 * 1024 + 1)]]) {
    await assert.rejects(read(...rows), { message: "Unsupported, ambiguous, oversized or unreadable local transcript." });
  }
});

test("time uses normalized result timestamp or, for unpaired attempts only, call timestamp", async t => {
  const read = await fixture(t);
  const call = (id: string, timestamp: string) => ({ ...assistant(bash(id, "npm test")), timestamp });
  const e = await read(call("a", "2026-01-01T00:00:00Z"), { ...user([result("a")]), timestamp: "2026-03-01T01:02:03.4+02:00" },
    call("b", "2026-02-30T00:00:00Z"), call("c", "SECRET"), call("d", "2024-02-29T12:13:14Z"));
  assert.deepEqual(e.checks.map(c => c.time), ["2026-02-28T23:02:03.400Z", undefined, undefined, "2024-02-29T12:13:14.000Z"]);
  assert.deepEqual(e.coverage, { unknown: 0, damaged: 0, unmatched: 3 });
});

test("coverage counts unknown lines once, damaged rows and distinct unmatched IDs", async t => {
  const read = await fixture(t);
  const e = await read(user("goal"), assistant({ type: "future" }, { type: "future" }), "{", assistant(bash("missing", "npm test")), user([result("orphan"), result("orphan")]));
  assert.deepEqual(e.coverage, { unknown: 1, damaged: 1, unmatched: 2 });
});

test("unknown record separates pending pairs but trailing damage retains confirmed evidence", async t => {
  const read = await fixture(t);
  const evidence = await read(assistant(bash("a", "pytest")), { ...user([result("a")]), toolUseResult: { exitCode: 0 } },
    assistant(bash("b", "npm test")), { type: "future", data: "SECRET" }, { ...user([result("b")]), toolUseResult: { exitCode: 0 } }, "{");
  assert.equal(evidence.partial, true);
  assert.deepEqual(evidence.checks.map(c => [c.outcome, c.resultLine]), [["PASS", 2], ["UNKNOWN", null]]);
});
