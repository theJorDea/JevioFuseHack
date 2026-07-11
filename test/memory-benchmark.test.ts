import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateRecall, formatBenchmarkMarkdown } from "../scripts/memory-benchmark.mjs";

test("memory benchmark contains 20 distinct scenarios and scores recall/staleness", async () => {
  const cases = JSON.parse(await readFile(new URL("../benchmark/memory-cases.json", import.meta.url), "utf8"));
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((item: { id: string }) => item.id)).size, cases.length);
  assert.ok(cases.filter((item: { forbidden?: string[] }) => item.forbidden?.length).length >= 4);

  const sample = [
    { id: "good", expected: ["current"], forbidden: ["obsolete"] },
    { id: "stale", expected: ["new"], forbidden: ["old"] },
  ];
  const scored = evaluateRecall(sample, new Map([
    ["good", "current decision"],
    ["stale", "new and old decisions"],
  ]), 25);
  assert.equal(scored.passed, 1);
  assert.equal(scored.recallAccuracy, 1);
  assert.equal(scored.staleErrorRate, 0.5);
  assert.equal(scored.toolCalls, 2);
  assert.match(formatBenchmarkMarkdown({ createdAt: "now", dataset: "temporary", off: scored, on: scored }), /Cognee on[\s\S]*Stale errors/);
});
