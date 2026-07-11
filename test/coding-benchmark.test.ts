import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { evaluateCodingCase, summarizeCodingBenchmark } from "../scripts/coding-benchmark.mjs";

test("coding benchmark defines distinct memory-dependent fixtures", async () => {
  const cases = JSON.parse(await readFile(new URL("../benchmark/coding-cases.json", import.meta.url), "utf8"));
  assert.ok(cases.length >= 3);
  assert.equal(new Set(cases.map((item: { id: string }) => item.id)).size, cases.length);
  assert.ok(cases.every((item: { memory?: string; expect?: unknown[] }) => item.memory && item.expect?.length));
});

test("coding benchmark evaluates files and summarizes on/off runs", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-coding-evaluate-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "result.js"), "export const value = 45;\n", "utf8");
  const evaluation = await evaluateCodingCase({
    expect: [{ path: "result.js", includes: ["45"], forbidden: ["10"] }],
  }, workspace);
  assert.equal(evaluation.passed, true);
  const summary = summarizeCodingBenchmark([
    { mode: "off", passed: false, toolCalls: 1, durationMs: 10 },
    { mode: "on", passed: true, toolCalls: 2, durationMs: 20 },
  ]);
  assert.equal(summary.off.successRate, 0);
  assert.equal(summary.on.successRate, 1);
});
