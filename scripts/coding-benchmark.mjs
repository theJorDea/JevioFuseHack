import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CogneeMemory } from "../src/memory.ts";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function evaluateCodingCase(testCase, workspace) {
  return Promise.all(testCase.expect.map(async (expectation) => {
    let content = "";
    try { content = await readFile(path.join(workspace, expectation.path), "utf8"); } catch {}
    const missing = expectation.includes.filter((value) => !content.includes(value));
    const forbidden = (expectation.forbidden ?? []).filter((value) => content.includes(value));
    return { path: expectation.path, passed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
  })).then((checks) => ({ passed: checks.every((check) => check.passed), checks }));
}

export function summarizeCodingBenchmark(results) {
  const modes = ["off", "on"];
  return Object.fromEntries(modes.map((mode) => {
    const rows = results.filter((result) => result.mode === mode);
    return [mode, {
      cases: rows.length,
      passed: rows.filter((row) => row.passed).length,
      successRate: rows.length ? rows.filter((row) => row.passed).length / rows.length : 0,
      toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0),
      durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    }];
  }));
}

async function waitForPipeline(memory, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await memory.status();
    if (status.pipelineStatus === "DATASET_PROCESSING_COMPLETED") return;
    if (status.pipelineStatus === "DATASET_PROCESSING_ERRORED") throw new Error("Cognee coding benchmark indexing failed.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Cognee coding benchmark indexing timed out.");
}

function benchmarkConfig(dataset, memoryEnabled) {
  const baseUrl = process.env.JEVIO_BENCH_BASE_URL;
  const model = process.env.JEVIO_BENCH_MODEL;
  if (!baseUrl || !model) throw new Error("JEVIO_BENCH_BASE_URL and JEVIO_BENCH_MODEL are required.");
  const provider = {
    baseUrl,
    defaultModel: model,
    toolMode: process.env.JEVIO_BENCH_TOOL_MODE ?? "auto",
    ...(process.env.JEVIO_BENCH_API_KEY ? { apiKeyEnv: "JEVIO_BENCH_API_KEY" } : {}),
  };
  const roles = Object.fromEntries(["orchestrator", "coder", "architect", "reviewer", "judge", "compactor"]
    .map((role) => [role, { provider: "benchmark", model, temperature: 0.1 }]));
  return {
    defaultProvider: "benchmark",
    providers: { benchmark: provider },
    roles,
    memory: {
      cognee: {
        enabled: memoryEnabled,
        baseUrl: "http://localhost:8000",
        baseUrlEnv: "COGNEE_BASE_URL",
        apiKeyEnv: "COGNEE_API_KEY",
        tenantIdEnv: "COGNEE_TENANT_ID",
        authMode: "x-api-key",
        dataset,
        timeoutMs: 60_000,
        maxResults: 6,
        maxContextCharacters: 8_000,
        maxRememberCharacters: 16_000,
        sessionAware: true,
        rememberCompletedTurns: false,
        rememberCompactions: false
      }
    },
    permissions: { autoApproveWorkspaceWrites: true, autoApproveShell: true, autoApprovePlugins: false, shellMode: "tests-only" },
  };
}

async function runCase(testCase, mode) {
  const workspace = path.join(root, `.tmp-test-coding-benchmark-${process.pid}-${testCase.id}-${mode}`);
  const dataset = `jevio-coding-benchmark-${Date.now()}-${testCase.id}`;
  const config = benchmarkConfig(dataset, mode === "on");
  let memory;
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  try {
    for (const [relative, content] of Object.entries(testCase.files)) {
      const file = path.join(workspace, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
    const configPath = path.join(workspace, "jevio.config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    if (mode === "on") {
      const memoryConfig = structuredClone(DEFAULT_CONFIG.memory.cognee);
      Object.assign(memoryConfig, config.memory.cognee, { sessionAware: false });
      memory = new CogneeMemory(memoryConfig, workspace);
      await memory.remember(testCase.memory, undefined, `coding-${testCase.id}.md`);
      await waitForPipeline(memory);
    }
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let executionError;
    try {
      const result = await execFileAsync(process.execPath, [
        path.join(root, "src", "cli.ts"), "--direct", "--yes", "--workspace", workspace, "--config", configPath, testCase.task,
      ], { cwd: workspace, env: process.env, maxBuffer: 2_000_000, timeout: 10 * 60_000 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
      executionError = error instanceof Error ? error.message : String(error);
    }
    const evaluation = await evaluateCodingCase(testCase, workspace);
    return {
      id: testCase.id,
      mode,
      passed: evaluation.passed && !executionError,
      checks: evaluation.checks,
      durationMs: Math.round(performance.now() - startedAt),
      toolCalls: (stderr.match(/\(running\)/g) ?? []).length,
      ...(executionError ? { error: executionError.slice(0, 1_000) } : {}),
      output: stdout.slice(-2_000),
    };
  } finally {
    if (memory) await memory.forget().catch(() => false);
    await rm(workspace, { recursive: true, force: true });
  }
}

export function formatCodingBenchmark(report) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  return [
    "# End-to-end coding benchmark Cognee on/off",
    "",
    `Дата: ${report.createdAt}`,
    "",
    "| Режим | Успешно | Success rate | Tool calls | Время |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| Cognee off | ${report.summary.off.passed}/${report.summary.off.cases} | ${percent(report.summary.off.successRate)} | ${report.summary.off.toolCalls} | ${report.summary.off.durationMs} ms |`,
    `| Cognee on | ${report.summary.on.passed}/${report.summary.on.cases} | ${percent(report.summary.on.successRate)} | ${report.summary.on.toolCalls} | ${report.summary.on.durationMs} ms |`,
    "",
    ...report.results.filter((result) => !result.passed).map((result) => `- FAIL \`${result.id}\` (${result.mode}): ${result.error ?? "file expectations not met"}`),
    "",
  ].join("\n");
}

async function main() {
  for (const name of ["COGNEE_BASE_URL", "COGNEE_API_KEY", "COGNEE_TENANT_ID"]) {
    if (!process.env[name]) throw new Error(`${name} is required for the Cognee-on run.`);
  }
  const cases = JSON.parse(await readFile(path.join(root, "benchmark", "coding-cases.json"), "utf8"));
  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase, "off"));
    results.push(await runCase(testCase, "on"));
  }
  const report = { createdAt: new Date().toISOString(), summary: summarizeCodingBenchmark(results), results };
  const outputDirectory = path.join(root, "benchmark", "results", "coding");
  await mkdir(outputDirectory, { recursive: true });
  const basename = report.createdAt.replace(/[:.]/g, "-");
  await writeFile(path.join(outputDirectory, `${basename}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDirectory, `${basename}.md`), `${formatCodingBenchmark(report)}\n`, "utf8");
  process.stdout.write(`${formatCodingBenchmark(report)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
