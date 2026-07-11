import assert from "node:assert/strict";
import test from "node:test";
import { validateMemoryBenchmark } from "../scripts/check-memory-benchmark.mjs";

const passing = {
  remoteDeletions: 4,
  on: { cases: 20, passed: 20, recallAccuracy: 1, staleErrorRate: 0 },
};

test("memory benchmark quality gate accepts the Cloud target", () => {
  assert.deepEqual(validateMemoryBenchmark(passing), []);
});

test("memory benchmark quality gate rejects recall and stale regressions", () => {
  const failures = validateMemoryBenchmark({
    remoteDeletions: 3,
    on: { cases: 20, passed: 18, recallAccuracy: 0.95, staleErrorRate: 0.25 },
  });
  assert.equal(failures.length, 4);
  assert.match(failures.join("\n"), /all cases[\s\S]*recall accuracy[\s\S]*stale error[\s\S]*remote deletions/);
});
