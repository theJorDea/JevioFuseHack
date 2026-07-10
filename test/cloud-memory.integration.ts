import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CogneeMemory } from "../src/memory.ts";

test("Cognee Cloud supports the complete Jevio memory lifecycle", { timeout: 240_000 }, async (t) => {
  if (!process.env.COGNEE_BASE_URL || !process.env.COGNEE_API_KEY) {
    t.skip("COGNEE_BASE_URL and COGNEE_API_KEY are required");
    return;
  }

  const config = structuredClone(DEFAULT_CONFIG.memory.cognee);
  config.enabled = true;
  config.baseUrlEnv = "COGNEE_BASE_URL";
  config.apiKeyEnv = "COGNEE_API_KEY";
  config.authMode = "x-api-key";
  config.dataset = `jevio-integration-${Date.now()}`;
  config.timeoutMs = 60_000;
  const memory = new CogneeMemory(config, process.cwd());
  const marker = `JEVIO_INTEGRATION_${Date.now()}`;
  let rememberAccepted = false;

  try {
    await memory.remember(
      `Integration marker ${marker}. Jevio uses Cognee for durable coding-agent memory.`,
      undefined,
      "integration.md",
    );
    rememberAccepted = true;

    let pipelineStatus: string | undefined;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      pipelineStatus = (await memory.status()).pipelineStatus;
      if (pipelineStatus === "DATASET_PROCESSING_COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.equal(pipelineStatus, "DATASET_PROCESSING_COMPLETED");

    const recalled = await memory.recall(`What is the integration marker ${marker}?`);
    assert.match(recalled, new RegExp(marker));
    await memory.improve();
  } finally {
    let removed = false;
    const cleanupAttempts = rememberAccepted ? 12 : 1;
    for (let attempt = 0; attempt < cleanupAttempts && !removed; attempt += 1) {
      try {
        removed = await memory.forget();
      } catch {}
      if (!removed) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (rememberAccepted) assert.equal(removed, true, `temporary Cognee dataset ${config.dataset} was not removed`);
  }
});
