import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { addProviderConfig, loadConfig, saveProviderSecret } from "../src/config.ts";

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

test("rejects invalid role sampling limits", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-config-invalid-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    roles: { coder: { model: "coder-test", temperature: 3 } },
  }));
  await assert.rejects(() => loadConfig(workspace), /temperature/);
});

test("adds a provider without writing its API key", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-config-provider-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  const file = await addProviderConfig(workspace, undefined, {
    name: "cloud",
    baseUrl: "https://api.example.test/v1/",
    apiKeyEnv: "CLOUD_API_KEY",
    model: "cloud-code-model",
  });
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    providers: { cloud: { baseUrl: string; apiKeyEnv: string } };
    roles: { coder: { provider: string; model: string } };
  };
  assert.deepEqual(saved.providers.cloud, { baseUrl: "https://api.example.test/v1", apiKeyEnv: "CLOUD_API_KEY" });
  assert.deepEqual(saved.roles.coder, { provider: "cloud", model: "cloud-code-model" });
});

test("loads a direct provider key from the ignored local secrets file", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-config-key-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await addProviderConfig(workspace, undefined, {
    name: "cloud",
    baseUrl: "https://api.example.test/v1",
    apiKeyEnv: "CLOUD_API_KEY",
    model: "cloud-code-model",
  });
  await saveProviderSecret(workspace, "cloud", "sk-direct-key");
  assert.equal((await loadConfig(workspace)).providers.cloud.apiKey, "sk-direct-key");
});
