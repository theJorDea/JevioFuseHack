import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateMemoryBenchmark(report) {
  const failures = [];
  if (!report || typeof report !== "object") failures.push("report is not an object");
  const on = report?.on;
  if (!on || typeof on !== "object") failures.push("Cognee on result is missing");
  if (on?.cases !== 20) failures.push(`expected 20 cases, got ${on?.cases ?? "missing"}`);
  if (on?.passed !== on?.cases) failures.push(`expected all cases to pass, got ${on?.passed ?? 0}/${on?.cases ?? 0}`);
  if (on?.recallAccuracy !== 1) failures.push(`expected recall accuracy 1, got ${on?.recallAccuracy ?? "missing"}`);
  if (on?.staleErrorRate !== 0) failures.push(`expected stale error rate 0, got ${on?.staleErrorRate ?? "missing"}`);
  if (!Number.isFinite(report?.remoteDeletions) || report.remoteDeletions < 4) {
    failures.push(`expected at least 4 remote deletions, got ${report?.remoteDeletions ?? "missing"}`);
  }
  return failures;
}

async function latestReport() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const directory = path.join(root, "benchmark", "results");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) throw new Error("No benchmark JSON reports found.");
  return path.join(directory, files.at(-1));
}

async function main() {
  const file = await latestReport();
  const report = JSON.parse(await readFile(file, "utf8"));
  const failures = validateMemoryBenchmark(report);
  if (failures.length) throw new Error(`Memory benchmark quality gate failed:\n- ${failures.join("\n- ")}`);
  process.stdout.write(`Memory benchmark quality gate passed: ${report.on.passed}/${report.on.cases}, stale errors 0%, remote deletions ${report.remoteDeletions}.\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
