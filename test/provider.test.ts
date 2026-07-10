import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTemperature, OpenAICompatibleClient } from "../src/provider/openai-compatible.ts";

test("Kimi models always use the provider-required temperature of 1", () => {
  assert.equal(effectiveTemperature({ model: "Kimi K2.7", temperature: 0.15 }), 1);
  assert.equal(effectiveTemperature({ model: "qwen3-coder", temperature: 0.15 }), 0.15);
});

test("Responses transport normalizes OpenAI function calls", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "Inspecting." }] },
        { type: "function_call", call_id: "call_1", name: "list_files", arguments: "{\"path\":\"src\"}" },
      ],
    }), { headers: { "content-type": "application/json" } });
  };
  const client = new OpenAICompatibleClient(
    { baseUrl: "https://api.openai.com/v1", transport: "responses", apiKey: "test" },
    { model: "gpt-5.2-codex" },
  );
  const result = await client.complete({
    messages: [{ role: "system", content: "System" }, { role: "user", content: "Inspect" }],
    tools: [{ type: "function", function: { name: "list_files", description: "List", parameters: { type: "object" } } }],
  });

  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(requestBody.instructions, "System");
  assert.equal(result.content, "Inspecting.");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "list_files", arguments: "{\"path\":\"src\"}" }]);
});
