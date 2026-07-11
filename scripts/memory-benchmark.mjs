import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CogneeMemory } from "../src/memory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function evaluateRecall(cases, contexts, durationMs = 0) {
  const results = cases.map((item) => {
    const context = String(contexts.get(item.id) ?? "");
    const normalized = context.toLocaleLowerCase();
    const expectedHits = item.expected.filter((term) => normalized.includes(term.toLocaleLowerCase()));
    const forbiddenHits = (item.forbidden ?? []).filter((term) => normalized.includes(term.toLocaleLowerCase()));
    return {
      id: item.id,
      passed: expectedHits.length === item.expected.length && forbiddenHits.length === 0,
      expectedHits: expectedHits.length,
      expectedTotal: item.expected.length,
      forbiddenHits,
      contextCharacters: context.length,
      estimatedTokens: Math.ceil(context.length / 4),
      context,
    };
  });
  const expectedTotal = results.reduce((sum, item) => sum + item.expectedTotal, 0);
  const expectedHits = results.reduce((sum, item) => sum + item.expectedHits, 0);
  const staleCases = cases.filter((item) => item.forbidden?.length).length;
  const staleFailures = results.filter((item) => item.forbiddenHits.length).length;
  return {
    cases: results.length,
    passed: results.filter((item) => item.passed).length,
    successRate: results.length ? results.filter((item) => item.passed).length / results.length : 0,
    recallAccuracy: expectedTotal ? expectedHits / expectedTotal : 0,
    staleErrorRate: staleCases ? staleFailures / staleCases : 0,
    estimatedTokens: results.reduce((sum, item) => sum + item.estimatedTokens, 0),
    toolCalls: contexts.size,
    durationMs,
    results,
  };
}

export function formatBenchmarkMarkdown(report) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Benchmark памяти Cognee on/off",
    "",
    `Дата: ${report.createdAt}`,
    `Dataset: \`${report.dataset}\` (временный, удалён после теста)` ,
    `Физически удалено устаревших Cognee sources: ${report.remoteDeletions ?? 0}`,
    "",
    "| Режим | Успешно | Recall accuracy | Stale errors | Tokens (оценка) | Tool calls | Время |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| Cognee off | ${report.off.passed}/${report.off.cases} | ${percent(report.off.recallAccuracy)} | ${percent(report.off.staleErrorRate)} | ${report.off.estimatedTokens} | ${report.off.toolCalls} | ${report.off.durationMs} ms |`,
    `| Cognee on | ${report.on.passed}/${report.on.cases} | ${percent(report.on.recallAccuracy)} | ${percent(report.on.staleErrorRate)} | ${report.on.estimatedTokens} | ${report.on.toolCalls} | ${report.on.durationMs} ms |`,
    "",
    "## Ошибки Cognee on",
    "",
  ];
  const failures = report.on.results.filter((item) => !item.passed);
  if (!failures.length) lines.push("Ошибок нет.");
  else failures.forEach((item) => lines.push(`- \`${item.id}\`: expected ${item.expectedHits}/${item.expectedTotal}; stale: ${item.forbiddenHits.join(", ") || "нет"}`));
  return `${lines.join("\n")}\n`;
}

async function waitForPipeline(memory, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await memory.status();
    if (status.pipelineStatus === "DATASET_PROCESSING_COMPLETED") return;
    if (status.pipelineStatus === "DATASET_PROCESSING_ERRORED") throw new Error("Cognee benchmark indexing failed.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Cognee benchmark indexing timed out.");
}

async function main() {
  for (const name of ["COGNEE_BASE_URL", "COGNEE_API_KEY", "COGNEE_TENANT_ID"]) {
    if (!process.env[name]) throw new Error(`${name} is required.`);
  }
  const cases = JSON.parse(await readFile(path.join(root, "benchmark", "memory-cases.json"), "utf8"));
  const config = structuredClone(DEFAULT_CONFIG.memory.cognee);
  config.enabled = true;
  config.baseUrlEnv = "COGNEE_BASE_URL";
  config.apiKeyEnv = "COGNEE_API_KEY";
  config.tenantIdEnv = "COGNEE_TENANT_ID";
  config.authMode = "x-api-key";
  config.dataset = `jevio-memory-benchmark-${Date.now()}`;
  config.timeoutMs = 60_000;
  config.sessionAware = false;
  const memory = new CogneeMemory(config, root);
  const corpus = cases.map((item) => [
    `## ${item.id}`,
    item.memory,
  ].join("\n")).join("\n\n");
  const off = evaluateRecall(cases, new Map());
  const contexts = new Map();
  const startedAt = performance.now();
  let remembered = false;
  let remoteDeletions = 0;
  try {
    const staleReceipts = [];
    for (const item of cases.filter((entry) => entry.staleMemory)) {
      const receipt = await memory.remember(item.staleMemory, undefined, `stale-${item.id}.md`);
      remembered = true;
      if (!receipt?.dataId) throw new Error(`Cognee remember did not return dataId for stale-${item.id}.md`);
      staleReceipts.push(receipt);
    }
    await waitForPipeline(memory);
    for (const receipt of staleReceipts) {
      if (await memory.forgetData(receipt.dataId, receipt.datasetId)) remoteDeletions += 1;
    }
    await memory.remember(corpus, undefined, "memory-benchmark.md");
    remembered = true;
    await waitForPipeline(memory);
    for (const item of cases) contexts.set(item.id, await memory.recall(item.query));
  } finally {
    if (remembered) await memory.forget();
  }
  const on = evaluateRecall(cases, contexts, Math.round(performance.now() - startedAt));
  const report = { createdAt: new Date().toISOString(), dataset: config.dataset, remoteDeletions, off, on };
  const outputDirectory = path.join(root, "benchmark", "results");
  await mkdir(outputDirectory, { recursive: true });
  const basename = report.createdAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDirectory, `${basename}.json`);
  const markdownPath = path.join(outputDirectory, `${basename}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, formatBenchmarkMarkdown(report), "utf8");
  process.stdout.write(`${formatBenchmarkMarkdown(report)}\nJSON: ${jsonPath}\nMarkdown: ${markdownPath}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
