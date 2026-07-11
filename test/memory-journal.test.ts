import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendMemoryProvenance,
  attachMemoryRemoteReceipt,
  clearMemoryProvenance,
  formatMemoryExplanation,
  listMemoryProvenance,
  supersededMemoryIds,
} from "../src/memory-journal.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-memory-journal-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("memory provenance records observable repository and verification data", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "changed.ts"), "export const changed = true;\n", "utf8");
  const record = await appendMemoryProvenance(root, {
    kind: "completed_task",
    projectId: "project-1",
    sessionId: "session-1",
    request: "Add provenance",
    result: "Implemented the journal.",
    verifications: [{ command: "npm test", exitCode: 0, summary: "all tests passed" }],
  });

  assert.equal(record.sessionId, "session-1");
  assert.equal(record.projectId, "project-1");
  assert.deepEqual(record.workingTreeFiles, ["changed.ts"]);
  assert.equal(record.verifications[0].exitCode, 0);
  assert.equal((await listMemoryProvenance(root))[0].id, record.id);
  await attachMemoryRemoteReceipt(root, record.id, {
    status: "running",
    datasetId: "dataset-1",
    dataId: "data-1",
    pipelineRunId: "run-1",
    contentHash: "a".repeat(64),
  });
  const linked = (await listMemoryProvenance(root))[0];
  assert.equal(linked.remote?.dataId, "data-1");
  assert.match(formatMemoryExplanation([linked]), /data=data-1[\s\S]*run=run-1[\s\S]*sha256=aaaaaaaaaaaa/);
  assert.match(formatMemoryExplanation([record], "recalled decision"), /recalled decision[\s\S]*project-1[\s\S]*changed\.ts[\s\S]*npm test/);
  const explained = formatMemoryExplanation([record], "recalled decision", {
    query: "why?",
    dataset: "project-memory",
    sessionId: "session-1",
    recalledAt: "2026-07-11T00:00:00.000Z",
    text: "recalled decision",
    items: [{
      text: "recalled decision",
      source: "graph",
      dataset: "project-memory",
      score: 0.87,
      timestamp: "2026-07-10T00:00:00.000Z",
    }],
  });
  assert.match(explained, /Запрос: why\?[\s\S]*source=graph[\s\S]*score=0\.87[\s\S]*timestamp=2026-07-10/);

  const replacement = await appendMemoryProvenance(root, {
    kind: "explicit_memory",
    projectId: "project-1",
    sessionId: "session-1",
    request: "Use the new decision",
    result: "Supersedes the old record.",
    verifications: [],
    supersedes: [record.id],
  });
  const records = await listMemoryProvenance(root, 500);
  assert.deepEqual(supersededMemoryIds(records), [record.id]);
  const replacementExplanation = formatMemoryExplanation(records);
  assert.match(replacementExplanation, new RegExp(`supersedes: ${record.id}`));
  assert.match(replacementExplanation, new RegExp(`superseded by ${replacement.id}`));

  await clearMemoryProvenance(root);
  assert.deepEqual(await listMemoryProvenance(root), []);
});
