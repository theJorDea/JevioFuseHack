import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { CogneeMemory } from "../src/memory.ts";

async function waitForPipeline(memory: CogneeMemory, attempts = 90): Promise<string | undefined> {
  let pipelineStatus: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    pipelineStatus = (await memory.status()).pipelineStatus;
    if (pipelineStatus === "DATASET_PROCESSING_COMPLETED" || pipelineStatus === "DATASET_PROCESSING_ERRORED") break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return pipelineStatus;
}

async function waitForRecall(
  memory: CogneeMemory,
  query: string,
  marker: string,
  sessionId?: string,
  attempts = 30,
): Promise<string> {
  let recalled = "";
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      recalled = await memory.recall(query, sessionId);
      if (recalled.includes(marker)) return recalled;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!recalled && lastError) throw lastError;
  return recalled;
}

test("Cognee Cloud supports permanent and session-aware Jevio memory", { timeout: 420_000 }, async (t) => {
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
  const sessionMarker = `JEVIO_SESSION_${Date.now()}`;
  const sessionId = `jevio-session-${Date.now()}`;
  let rememberAccepted = false;

  try {
    await memory.remember(
      `Integration marker ${marker}. Jevio uses Cognee for durable coding-agent memory.`,
      undefined,
      "integration.md",
    );
    rememberAccepted = true;

    const pipelineStatus = await waitForPipeline(memory);
    assert.equal(pipelineStatus, "DATASET_PROCESSING_COMPLETED");

    const recalled = await waitForRecall(memory, `Return the exact integration marker ${marker}.`, marker);
    assert.match(recalled, new RegExp(marker));

    await memory.remember(
      `Session marker ${sessionMarker}. This decision must survive a Jevio session boundary.`,
      sessionId,
      "session-integration.md",
    );
    const sessionRecall = await waitForRecall(
      memory,
      `Return the exact session marker ${sessionMarker}.`,
      sessionMarker,
      sessionId,
      15,
    );
    assert.match(sessionRecall, new RegExp(sessionMarker));

    await memory.improve([sessionId]);
    const bridgedRecall = await waitForRecall(
      memory,
      `Return the exact session marker ${sessionMarker}.`,
      sessionMarker,
      `${sessionId}-new`,
      60,
    );
    assert.match(bridgedRecall, new RegExp(sessionMarker));
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
