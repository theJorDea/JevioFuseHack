import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleClient } from "../src/provider/openai-compatible.ts";

test("streams Kimi reasoning_content and accumulates streamed tool calls", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"reasoning_content":"Inspecting the project. "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"I will read the entry file."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"_file","arguments":"\\"index.html\\"}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });

  const client = new OpenAICompatibleClient({ baseUrl: "https://api.example.test/v1" }, { model: "Kimi K2.7" });
  const deltas: string[] = [];
  const result = await client.complete({ messages: [{ role: "user", content: "Inspect files" }] }, (delta) => {
    if (delta.type === "reasoning") deltas.push(delta.delta);
  });

  assert.equal(deltas.join(""), "Inspecting the project. I will read the entry file.");
  assert.equal(result.toolCalls[0]?.name, "read_file");
  assert.equal(result.toolCalls[0]?.arguments, "{\"path\":\"index.html\"}");
  assert.equal(result.rawMessage.reasoning_content, "Inspecting the project. I will read the entry file.");
});
