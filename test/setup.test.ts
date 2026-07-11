import assert from "node:assert/strict";
import test from "node:test";
import { defaultModel, discoverLocalProviders, isSupportedNodeVersion, listProviderModels, parseModelsPayload } from "../src/setup.ts";

test("setup discovers local Ollama and LM Studio model endpoints", async () => {
  const providers = await discoverLocalProviders(async (url) => {
    if (url.includes("11434")) {
      return { ok: true, json: async () => ({ models: [{ name: "qwen3:14b" }, { name: "qwen3-coder:30b" }] }) };
    }
    return { ok: true, json: async () => ({ data: [{ id: "local-model" }] }) };
  });

  assert.deepEqual(providers, [
    { name: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3:14b", "qwen3-coder:30b"] },
    { name: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", models: ["local-model"] },
  ]);
  assert.equal(defaultModel(providers[0].models), "qwen3-coder:30b");
});

test("setup keeps only reachable providers and validates supported Node versions", async () => {
  const providers = await discoverLocalProviders(async (url) => {
    if (url.includes("11434")) throw new Error("offline");
    return { ok: true, json: async () => ({ data: [] }) };
  });

  assert.deepEqual(providers, [{ name: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", models: [] }]);
  assert.equal(isSupportedNodeVersion("v22.19.0"), true);
  assert.equal(isSupportedNodeVersion("v22.18.0"), false);
  assert.equal(isSupportedNodeVersion("v23.0.0"), true);
});

test("parseModelsPayload accepts OpenAI, Ollama, and bare arrays", () => {
  assert.deepEqual(parseModelsPayload({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(parseModelsPayload({ models: [{ name: "qwen3:14b" }] }), ["qwen3:14b"]);
  assert.deepEqual(parseModelsPayload(["x", "y"]), ["x", "y"]);
});

test("listProviderModels hits OpenAI-compatible /models", async () => {
  const seen: string[] = [];
  const models = await listProviderModels("http://example.test/v1", {
    apiKey: "secret",
    fetcher: async (url, init) => {
      seen.push(String(url));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      return { ok: true, json: async () => ({ data: [{ id: "gpt-test" }, { id: "coder-7b" }] }) };
    },
  });
  assert.equal(seen[0], "http://example.test/v1/models");
  assert.deepEqual(models, ["coder-7b", "gpt-test"]);
});
