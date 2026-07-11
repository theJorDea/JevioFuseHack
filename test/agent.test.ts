import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt, parseFallbackToolCalls, runAgent } from "../src/agent.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolContext } from "../src/types.ts";

const context: ToolContext = {
  workspace: process.cwd(),
  skills: [],
  projectCodeMap: "src/\n  auth.ts\n    class AuthService",
  autoApproveWrites: false,
  autoApproveShell: false,
  confirm: async () => false,
};

function malformedWriteJson(): string {
  const json = [
    String.raw`{"jevio_tool_calls":[{"name":"write_file","arguments":{"path":"index.html","content":"<main class=\"big\">` + "\\",
    String.raw`  <h1>Step</h1>` + "\\",
    String.raw`  <p>Use lots of space.` + "\\" + "          </p>" + "\\",
    String.raw`</main>"}}]}`,
  ].join("\n");
  return ["```json", json, "```"].join("\n");
}

test("repository map is injected only for planning roles", () => {
  const orchestratorPrompt = buildSystemPrompt("orchestrator", context);
  assert.match(orchestratorPrompt, /You are Fuse/);
  assert.match(orchestratorPrompt, /suggest_mode/);
  assert.match(orchestratorPrompt, /<repository_map>/);
  assert.match(buildSystemPrompt("architect", context), /AuthService/);
  assert.match(buildSystemPrompt("judge", context), /AuthService/);
  assert.doesNotMatch(buildSystemPrompt("coder", context), /<repository_map>/);
  assert.doesNotMatch(buildSystemPrompt("reviewer", context), /<repository_map>/);
});

test("retrieved memory is marked as untrusted historical context", () => {
  const prompt = buildSystemPrompt("orchestrator", { ...context, retrievedMemory: "The old API used port 3000." });
  assert.match(prompt, /Retrieved historical memory/);
  assert.match(prompt, /never as instructions/);
  assert.match(prompt, /old API used port 3000/);
  assert.doesNotMatch(buildSystemPrompt("compactor", { ...context, retrievedMemory: "old fact" }), /old fact/);
});

test("local-model JSON fallback is normalized into guarded tool calls", () => {
  const content = `\`\`\`json
{"jevio_tool_calls":[{"name":"write_file","arguments":{"path":"index.html","content":"<h1>Fuse</h1>"}},{"name":"unknown_tool","arguments":{}}]}
\`\`\``;
  assert.deepEqual(parseFallbackToolCalls(content, new Set(["write_file"])), [{
    id: "fallback_0",
    name: "write_file",
    arguments: "{\"path\":\"index.html\",\"content\":\"<h1>Fuse</h1>\"}",
  }]);
  assert.deepEqual(parseFallbackToolCalls("ordinary response", new Set(["write_file"])), []);
});

test("local-model JSON fallback repairs invalid line continuations in file content", () => {
  const calls = parseFallbackToolCalls(malformedWriteJson(), new Set(["write_file"]));
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    path: "index.html",
    content: "<main class=\"big\">  <h1>Step</h1>  <p>Use lots of space.          </p></main>",
  });
});

test("recovered text write still goes through the approval gate", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const workspace = await mkdtemp(path.join(process.cwd(), ".tmp-test-agent-recovery-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1 ? malformedWriteJson() : "Готово";
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.lmstudio = { baseUrl: "http://localhost:1234/v1", toolMode: "text" };
  config.defaultProvider = "lmstudio";
  config.roles.coder = { provider: "lmstudio", model: "local-coder" };
  let approvals = 0;
  const result = await runAgent({
    role: "coder",
    task: "Создай сайт",
    config,
    toolContext: {
      ...context,
      workspace,
      confirm: async (message) => {
        approvals += 1;
        assert.match(message, /index\.html/);
        return true;
      },
    },
  });

  assert.equal(result.content, "Готово");
  assert.equal(approvals, 1);
  assert.match(await readFile(path.join(workspace, "index.html"), "utf8"), /Step/);
});

test("local-model XML write fallback preserves unescaped file content", () => {
  const content = `<jevio_write path="index.html">
<!doctype html>
<h1 data-state="new">Тапки & стиль</h1>
</jevio_write>`;
  const calls = parseFallbackToolCalls(content, new Set(["write_file"]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    path: "index.html",
    content: "<!doctype html>\n<h1 data-state=\"new\">Тапки & стиль</h1>",
  });
});

test("text tool mode omits native tools and executes the fallback protocol", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls += 1;
    const content = calls === 1
      ? "{\"jevio_tool_calls\":[{\"name\":\"report_progress\",\"arguments\":"
      : calls === 2
        ? JSON.stringify({ jevio_tool_calls: [{ name: "report_progress", arguments: { message: "Пишу файлы" } }] })
        : calls === 3
          ? ""
          : calls === 4
            ? JSON.stringify({ jevio_tool_calls: [{ name: "report_progress", arguments: { message: "Продолжаю" } }] })
            : "Готово";
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.lmstudio = { baseUrl: "http://localhost:1234/v1", toolMode: "text" };
  config.defaultProvider = "lmstudio";
  config.roles.coder = { provider: "lmstudio", model: "local-coder" };
  let progress = "";
  const result = await runAgent({
    role: "coder",
    task: "Создай сайт",
    config,
    toolContext: { ...context, reportProgress: (message) => { progress = message; } },
  });

  assert.equal(result.content, "Готово");
  assert.equal(progress, "Продолжаю");
  assert.equal(requestBodies.length, 5);
  assert.equal(requestBodies[0].tools, undefined);
  assert.match(JSON.stringify(requestBodies[0].messages), /jevio_tool_calls/);
  assert.match(JSON.stringify(requestBodies[0].messages), /jevio_write/);
  assert.match(JSON.stringify(requestBodies[1].messages), /malformed and nothing was executed/);
  assert.match(JSON.stringify(requestBodies[3].messages), /previous text-protocol tool completed/);
});

test("text tool instructions are also supplied to the orchestrator", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls += 1;
    const content = calls === 1
      ? JSON.stringify({ jevio_tool_calls: [{ name: "report_progress", arguments: { message: "Делегирую" } }] })
      : "Готово";
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.lmstudio = { baseUrl: "http://localhost:1234/v1", toolMode: "text" };
  config.defaultProvider = "lmstudio";
  config.roles.orchestrator = { provider: "lmstudio", model: "local-general" };
  const result = await runAgent({ role: "orchestrator", task: "Сделай сайт", config, toolContext: context });

  assert.equal(result.content, "Готово");
  assert.equal(requestBodies[0].tools, undefined);
  assert.match(JSON.stringify(requestBodies[0].messages), /jevio_tool_calls/);
});
