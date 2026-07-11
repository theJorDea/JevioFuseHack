import { spawnSync } from "node:child_process";

const stableIsolationFlag = "--test-isolation";
const experimentalIsolationFlag = "--experimental-test-isolation";
const isolationFlag = process.allowedNodeEnvironmentFlags.has(stableIsolationFlag)
  ? stableIsolationFlag
  : experimentalIsolationFlag;
const files = process.argv.slice(2);

if (!files.length) {
  process.stderr.write("Usage: node scripts/run-tests.mjs <test files...>\n");
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [
    "--test",
    `${isolationFlag}=none`,
    ...files,
  ], { stdio: "inherit" });

  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.status ?? 1;
  }
}
