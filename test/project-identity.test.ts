import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  cogneeConfigForProject,
  legacyProjectDataset,
  loadProjectIdentity,
} from "../src/project-identity.ts";

function workspacePath(): string {
  return path.join(process.cwd(), `.tmp-test-project-identity-${process.pid}-${Date.now()}`);
}

test("project identity preserves the legacy dataset after the workspace moves", async (t) => {
  const root = workspacePath();
  const moved = `${root}-moved`;
  await mkdir(root, { recursive: true });
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(moved, { recursive: true, force: true }),
  ]));

  const [first, concurrent] = await Promise.all([
    loadProjectIdentity(root),
    loadProjectIdentity(root),
  ]);
  assert.equal(first.id, concurrent.id);
  assert.equal(first.dataset, legacyProjectDataset(root));

  await rename(root, moved);
  const afterMove = await loadProjectIdentity(moved);
  assert.deepEqual(afterMove, first);
  assert.notEqual(afterMove.dataset, legacyProjectDataset(moved));

  const automatic = cogneeConfigForProject(structuredClone(DEFAULT_CONFIG.memory.cognee), afterMove);
  assert.equal(automatic.dataset, first.dataset);
  const explicit = structuredClone(DEFAULT_CONFIG.memory.cognee);
  explicit.dataset = "shared-team-memory";
  assert.equal(cogneeConfigForProject(explicit, afterMove), explicit);
});

test("invalid project identity is reported instead of silently replacing memory scope", async (t) => {
  const root = workspacePath();
  await mkdir(path.join(root, ".jevio"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".jevio", "project.json"), "{}\n", "utf8");
  await assert.rejects(() => loadProjectIdentity(root), /Invalid Jevio project id/);
});
