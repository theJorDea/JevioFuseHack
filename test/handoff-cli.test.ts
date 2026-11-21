import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/jevio.mjs", import.meta.url));
const id = "10000000-1111-4222-8000-111111111111";
const second = "20000000-1111-4222-8000-111111111111";
const secret = "PRIVATE_HANDOFF_TEST_CANARY";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jh-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  const config = path.join(root, "claude");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    CLAUDE_CONFIG_DIR: config, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig") };
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  const bucket = path.join(config, "projects", cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(bucket, { recursive: true });
  const transcript = async (session = id, identity = cwd, partial = false) => {
    const file = path.join(bucket, `${session}.jsonl`);
    const rows = [
      { type: "user", message: { role: "user", content: `goal ${secret}` } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: `pytest ${secret}` } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: `stdout ${secret}` }] }, toolUseResult: { exitCode: 1 } },
    ];
    await writeFile(file, rows.map(r => JSON.stringify({ sessionId: session, cwd: identity, ...r })).join("\n") + (partial ? "\n{" : "\n"));
    return file;
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, "handoff", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    if (result.error) throw result.error;
    assert.notEqual(result.status, null, `process killed: ${result.signal}`);
    assert.ok(!(result.stdout + result.stderr).includes(secret), "leaked private data");
    return result;
  };
  return { root, cwd, git, run, transcript, output: path.join(cwd, "HANDOFF.md") };
}

test("previews partial evidence on an unborn branch; saves only explicitly and never overwrites", async t => {
  const { cwd, run, transcript, output } = await fixture(t);
  const file = await transcript(id, cwd, true);
  const preview = run("--transcript", file);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /PARTIAL/);
  assert.match(preview.stdout, /pytest.*FAIL.*exit 1/i);
  assert.match(preview.stdout, /UNKNOWN/);
  assert.match(preview.stdout, /HEAD: unborn; staged: 0; unstaged: 0; untracked: 0/);
  assert.deepEqual(await readdir(cwd), [".git"]);
  const save = run("--transcript", file, "--save");
  assert.equal(save.status, 0, save.stderr);
  assert.equal(await readFile(output, "utf8"), preview.stdout);
  await writeFile(output, "existing report\n");
  assert.notEqual(run("--transcript", file, "--save").status, 0);
  assert.equal(await readFile(output, "utf8"), "existing report\n");
  assert.deepEqual((await readdir(cwd)).sort(), [".git", "HANDOFF.md"]);
});

test("reports actual commit and index/worktree counts without disclosing filenames or diff", async t => {
  const { cwd, git, run, transcript } = await fixture(t);
  await transcript();
  await writeFile(path.join(cwd, "tracked"), "initial");
  git("add", "tracked");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
  await writeFile(path.join(cwd, "tracked"), secret);
  await writeFile(path.join(cwd, "staged"), "");
  git("add", "staged");
  await writeFile(path.join(cwd, secret), "");
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(preview.stdout.includes(`HEAD: ${git("rev-parse", "HEAD")}; staged: 1; unstaged: 1; untracked: 1`));
});

test("rejects a transcript bound to a different working copy even when explicitly selected", async t => {
  const { root, output, run, transcript } = await fixture(t);
  const foreign = path.join(root, "other");
  await mkdir(foreign);
  const result = run("--transcript", await transcript(id, foreign), "--save");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worktree/i);
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("fails outside a Git worktree without creating a report", async t => {
  const { cwd, run, transcript, output } = await fixture(t);
  const file = await transcript();
  await rm(path.join(cwd, ".git"), { recursive: true });
  const result = run("--transcript", file, "--save");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git worktree/i);
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("ambiguous discovery does not save; an explicit session resolves the ambiguity", async t => {
  const { run, transcript, output } = await fixture(t);
  await transcript();
  await transcript(second);
  const ambiguous = run("--save");
  assert.notEqual(ambiguous.status, 0);
  for (const token of [id, second, "--session"]) assert.ok(ambiguous.stderr.includes(token));
  await assert.rejects(readFile(output), { code: "ENOENT" });
  const selected = run("--session", second, "--omit-git");
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /pytest.*FAIL/);
  assert.doesNotMatch(selected.stdout, /HEAD:/);
});
