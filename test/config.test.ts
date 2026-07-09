import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loads partial config, expands environment, and fills role defaults", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-config-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  process.env.JEVIO_TEST_KEY = "secret";
  t.after(() => delete process.env.JEVIO_TEST_KEY);
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    providers: {
      test: { baseUrl: "http://localhost:9999/v1", apiKey: "${JEVIO_TEST_KEY}" },
    },
    defaultProvider: "test",
    roles: {
      coder: { model: "coder-test" },
    },
  }));

  const config = await loadConfig(workspace);
  assert.equal(config.providers.test.apiKey, "secret");
  assert.equal(config.roles.coder.model, "coder-test");
  assert.equal(config.roles.orchestrator.model, "qwen3:14b");
  assert.equal(config.roles.compactor.model, "qwen3:14b");
  assert.equal(config.agent.maxTurns, 24);
  assert.equal(config.agent.keepRecentToolResults, 6);
  assert.equal(config.compaction.contextWindowTokens, 32768);
  assert.equal(config.codeIndex.backend, "auto");
});
