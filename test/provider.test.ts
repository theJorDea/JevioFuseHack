import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTemperature } from "../src/provider/openai-compatible.ts";

test("Kimi models always use the provider-required temperature of 1", () => {
  assert.equal(effectiveTemperature({ model: "Kimi K2.7", temperature: 0.15 }), 1);
  assert.equal(effectiveTemperature({ model: "qwen3-coder", temperature: 0.15 }), 0.15);
});
