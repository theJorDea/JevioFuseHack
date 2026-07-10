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

test("stream transport retries once without streaming after LM Studio termination", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error("terminated")); },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Recovered" } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const client = new OpenAICompatibleClient(
    { baseUrl: "http://localhost:1234/v1" },
    { model: "local-model" },
  );
  const result = await client.complete({ messages: [{ role: "user", content: "Hello" }] }, () => {});
  assert.equal(result.content, "Recovered");
  assert.equal(calls, 2);
});
