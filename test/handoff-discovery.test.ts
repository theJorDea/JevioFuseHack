import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { discoverHandoffSessions } from "../src/handoff-discovery.ts";

const id = "a0123456-1234-4abc-8def-0123456789ab";
const other = "b0123456-1234-4abc-8def-0123456789ab";
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jevio-disco-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "my.repo_ café");
  const config = path.join(root, "config");
  await mkdir(workspace);
  const key = (await realpath(workspace)).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  const bucket = path.join(config, "projects", key);
  return { root, workspace, config, bucket };
}

test("lists only top-level UUID transcript files in the canonical workspace bucket", async t => {
  const { root, workspace, config, bucket } = await setup(t);
  const alias = path.join(root, "alias");
  await symlink(workspace, alias, "junction");
  await mkdir(bucket, { recursive: true });
  await mkdir(`${bucket}-other`);
  await writeFile(path.join(`${bucket}-other`, `${other}.jsonl`), "");
  await mkdir(path.join(bucket, `${other}.jsonl`));
  for (const name of [`${id}.jsonl`, "sessions-index.json", "agent-123.jsonl", `${id}.jsonl.bak`, `${id}.JSONL.bak`]) {
    await writeFile(path.join(bucket, name), "intentionally not a transcript");
  }
  assert.deepEqual(await discoverHandoffSessions(alias, config), [{ id, path: path.join(bucket, `${id}.jsonl`) }]);
});

test("explicit override precedes CLAUDE_CONFIG_DIR; missing storage is empty", async t => {
  const { root, workspace, config, bucket } = await setup(t);
  const prior = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior; });
  process.env.CLAUDE_CONFIG_DIR = config;
  await mkdir(bucket, { recursive: true });
  await writeFile(path.join(bucket, `${id}.jsonl`), "");
  assert.equal((await discoverHandoffSessions(workspace))[0]?.id, id);
  assert.deepEqual(await discoverHandoffSessions(workspace, path.join(root, "missing")), []);
});

for (const level of ["config", "projects", "bucket"] as const) {
  test(`ignores a linked ${level} directory`, async t => {
    const { root, workspace, config, bucket } = await setup(t);
    const link = level === "config" ? config : level === "projects" ? path.dirname(bucket) : bucket;
    const target = path.join(root, "outside");
    const redirectedBucket = path.join(target, path.relative(link, bucket));
    await mkdir(redirectedBucket, { recursive: true });
    await writeFile(path.join(redirectedBucket, `${id}.jsonl`), "");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, "junction");
    assert.deepEqual(await discoverHandoffSessions(workspace, config), []);
  });
}

test("does not follow a transcript file symlink", async t => {
  const { root, workspace, config, bucket } = await setup(t);
  await mkdir(bucket, { recursive: true });
  const target = path.join(root, "outside.txt");
  await writeFile(target, "");
  try { await symlink(target, path.join(bucket, `${id}.jsonl`), "file"); } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return t.skip("file symlinks require Windows developer mode or privilege");
    throw error;
  }
  assert.deepEqual(await discoverHandoffSessions(workspace, config), []);
});
