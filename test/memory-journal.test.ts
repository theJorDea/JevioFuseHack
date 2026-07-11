import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendMemoryProvenance,
  clearMemoryProvenance,
  formatMemoryExplanation,
  listMemoryProvenance,
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
    sessionId: "session-1",
    request: "Add provenance",
    result: "Implemented the journal.",
    verifications: [{ command: "npm test", exitCode: 0, summary: "all tests passed" }],
  });

  assert.equal(record.sessionId, "session-1");
  assert.deepEqual(record.workingTreeFiles, ["changed.ts"]);
  assert.equal(record.verifications[0].exitCode, 0);
  assert.equal((await listMemoryProvenance(root))[0].id, record.id);
  assert.match(formatMemoryExplanation([record], "recalled decision"), /recalled decision[\s\S]*changed\.ts[\s\S]*npm test/);

  await clearMemoryProvenance(root);
  assert.deepEqual(await listMemoryProvenance(root), []);
});
