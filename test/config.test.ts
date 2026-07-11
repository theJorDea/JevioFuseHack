import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { addProviderConfig, loadConfig, saveProviderSecret, setAllRolesModelConfig, setDefaultProviderConfig, setRoleProviderConfig } from "../src/config.ts";

test("loads partial config, expands environment, and fills role defaults", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-${process.pid}-${Date.now()}`);
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
  assert.equal(config.roles.judge.model, "qwen3:14b");
  assert.equal(config.roles.compactor.model, "qwen3:14b");
  assert.equal(config.agent.maxTurns, 24);
  assert.equal(config.agent.keepRecentToolResults, 6);
  assert.equal(config.agent.maxParallelReadAgents, 1);
  assert.equal(config.compaction.contextWindowTokens, 32768);
  assert.equal(config.codeIndex.backend, "auto");
  assert.equal(config.memory.cognee.enabled, false);
  assert.equal(config.memory.cognee.baseUrl, "http://localhost:8000");
  assert.equal(config.memory.cognee.sessionAware, true);
});

test("loads disabled MCP plugin configs without enabling plugin approvals", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-mcp-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  process.env.JEVIO_MCP_TOKEN = "plugin-secret";
  t.after(() => delete process.env.JEVIO_MCP_TOKEN);
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    plugins: {
      mcp: {
        github: {
          command: "node",
          args: ["server.mjs"],
          env: { GITHUB_TOKEN: "${JEVIO_MCP_TOKEN}" },
          roles: ["coder", "reviewer"],
        },
      },
    },
  }));

  const config = await loadConfig(workspace);
  assert.equal(config.plugins.mcp.github.enabled, false);
  assert.equal(config.plugins.mcp.github.env.GITHUB_TOKEN, "plugin-secret");
  assert.deepEqual(config.plugins.mcp.github.roles, ["coder", "reviewer"]);
  assert.equal(config.permissions.autoApprovePlugins, false);
});

test("rejects invalid role sampling limits", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-invalid-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    roles: { coder: { model: "coder-test", temperature: 3 } },
  }));
  await assert.rejects(() => loadConfig(workspace), /temperature/);
});

test("loads and validates Cognee memory settings", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-memory-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    memory: { cognee: { enabled: true, baseUrl: "https://memory.example.test/api/v1", baseUrlEnv: "COGNEE_BASE_URL", authMode: "bearer", maxResults: 3 } },
  }));
  const config = await loadConfig(workspace);
  assert.equal(config.memory.cognee.enabled, true);
  assert.equal(config.memory.cognee.authMode, "bearer");
  assert.equal(config.memory.cognee.baseUrlEnv, "COGNEE_BASE_URL");
  assert.equal(config.memory.cognee.maxResults, 3);
  assert.equal(config.memory.cognee.maxContextCharacters, 8000);

  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({ memory: { cognee: { baseUrl: "file:///memory" } } }));
  await assert.rejects(() => loadConfig(workspace), /baseUrl/);
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({ memory: { cognee: { baseUrlEnv: "not valid" } } }));
  await assert.rejects(() => loadConfig(workspace), /baseUrlEnv/);
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({ memory: { cognee: { sessionAware: "yes" } } }));
  await assert.rejects(() => loadConfig(workspace), /sessionAware/);
});

test("adds a provider without writing its API key", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-provider-${process.pid}-${Date.now()}`);
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
  assert.deepEqual(saved.providers.cloud, { baseUrl: "https://api.example.test/v1", apiKeyEnv: "CLOUD_API_KEY", defaultModel: "cloud-code-model" });
  assert.deepEqual(saved.roles.coder, { provider: "cloud", model: "cloud-code-model" });
});

test("can register a provider without rebinding every role", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-provider-register-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    defaultProvider: "ollama",
    providers: { ollama: { baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3:14b" } },
    roles: {
      coder: { provider: "ollama", model: "qwen3-coder:30b" },
      architect: { provider: "ollama", model: "qwen3:14b" },
    },
  }));
  await addProviderConfig(workspace, undefined, {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.2",
  }, { applyToAllRoles: false });
  const saved = JSON.parse(await readFile(path.join(workspace, "jevio.config.json"), "utf8")) as {
    defaultProvider: string;
    providers: { ollama: unknown; openrouter: { baseUrl: string; defaultModel: string } };
    roles: { coder: { provider: string; model: string }; architect: { provider: string; model: string } };
  };
  assert.equal(saved.defaultProvider, "ollama");
  assert.deepEqual(saved.providers.openrouter, {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.2",
  });
  assert.deepEqual(saved.roles.coder, { provider: "ollama", model: "qwen3-coder:30b" });
  assert.deepEqual(saved.roles.architect, { provider: "ollama", model: "qwen3:14b" });
});

test("existing LM Studio providers default to the text tool protocol", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-config-lmstudio-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    defaultProvider: "lmstudio",
    providers: { lmstudio: { baseUrl: "http://localhost:1234/v1" } },
  }));

  assert.equal((await loadConfig(workspace)).providers.lmstudio.toolMode, "text");
});

test("loads a direct provider key from the ignored local secrets file", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-key-${process.pid}-${Date.now()}`);
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

test("assigns a provider and model to one role without losing provider headers", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-role-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    providers: {
      cloud: {
        baseUrl: "https://api.example.test/v1",
        defaultModel: "cloud-default",
        headers: { "x-client": "fuse" },
      },
    },
  }));
  await setRoleProviderConfig(workspace, undefined, "reviewer", "cloud", "cloud-review");
  const saved = JSON.parse(await readFile(path.join(workspace, "jevio.config.json"), "utf8")) as {
    providers: { cloud: { headers: Record<string, string> } };
    roles: { reviewer: { provider: string; model: string } };
  };
  assert.deepEqual(saved.roles.reviewer, { provider: "cloud", model: "cloud-review" });
  assert.deepEqual(saved.providers.cloud.headers, { "x-client": "fuse" });
});

test("setDefaultProviderConfig switches provider and can apply default model", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-provider-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    defaultProvider: "a",
    providers: {
      a: { baseUrl: "http://localhost:1/v1", defaultModel: "model-a" },
      b: { baseUrl: "http://localhost:2/v1", defaultModel: "model-b" },
    },
    roles: {
      coder: { provider: "a", model: "model-a" },
      orchestrator: { provider: "a", model: "model-a" },
    },
  }));
  await setDefaultProviderConfig(workspace, undefined, "b");
  let loaded = await loadConfig(workspace);
  assert.equal(loaded.defaultProvider, "b");
  assert.equal(loaded.roles.coder.provider, "b");
  assert.equal(loaded.roles.coder.model, "model-a"); // model kept
  await setDefaultProviderConfig(workspace, undefined, "b", { applyDefaultModel: true });
  loaded = await loadConfig(workspace);
  assert.equal(loaded.roles.coder.model, "model-b");
});

test("setAllRolesModelConfig applies one model to every role", async (t) => {
  const workspace = path.join(tmpdir(), `.tmp-test-config-models-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    defaultProvider: "custom",
    providers: {
      custom: { baseUrl: "http://localhost:9999/v1", defaultModel: "old-model" },
    },
    roles: {
      coder: { provider: "custom", model: "old-model" },
    },
  }));
  await setAllRolesModelConfig(workspace, undefined, "new-model", "custom");
  const loaded = await loadConfig(workspace);
  assert.equal(loaded.providers.custom.defaultModel, "new-model");
  for (const role of Object.values(loaded.roles)) {
    assert.equal(role.model, "new-model");
    assert.equal(role.provider, "custom");
  }
});
