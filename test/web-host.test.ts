import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listMemoryProvenance } from "../src/memory-journal.ts";
import { WebHost } from "../src/web-host.ts";

test("WebHost boots with empty workspace session", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-webhost-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    defaultProvider: "ollama",
    providers: { ollama: { baseUrl: "http://127.0.0.1:9/v1" } },
    roles: {
      orchestrator: { model: "test" },
      coder: { model: "test" },
      architect: { model: "test" },
      reviewer: { model: "test" },
      judge: { model: "test" },
      compactor: { model: "test" },
    },
  }));

  const host = await WebHost.create(workspace);
  const status = host.status();
  assert.equal(status.workspace, path.resolve(workspace));
  assert.ok(status.sessionId);
  assert.equal(status.mode, "orchestrate");
  assert.equal(status.busy, false);

  const created = await host.newSession();
  assert.ok(created.sessionId);
  host.setYolo(true);
  host.setMode("direct");
  assert.equal(host.status().yolo, true);
  assert.equal(host.status().mode, "direct");

  const sessions = await host.listSessions();
  assert.ok(sessions.length >= 1);

  const settings = host.getSettings();
  assert.ok(settings.providers.length >= 1);
  assert.ok(settings.roles.length >= 1);
  assert.equal(settings.defaultProvider, "ollama");
});

test("WebHost remembers completed turns in session memory and improves the session on rollover", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-webhost-memory-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "jevio.config.json"), JSON.stringify({
    defaultProvider: "mock",
    providers: { mock: { baseUrl: "http://model.test/v1" } },
    roles: {
      orchestrator: { model: "test" },
      coder: { model: "test" },
      architect: { model: "test" },
      reviewer: { model: "test" },
      judge: { model: "test" },
      compactor: { model: "test" },
    },
    memory: {
      cognee: {
        enabled: true,
        baseUrl: "http://memory.test",
        dataset: "web-project",
        sessionAware: true,
        rememberCompletedTurns: true,
      },
    },
  }));

  const originalFetch = globalThis.fetch;
  const memoryRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Web memory stored." } }],
      }), { headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    memoryRequests.push({ url, body });
    if (url.endsWith("/recall")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const host = await WebHost.create(workspace);
  host.setMode("direct");
  const sessionId = host.status().sessionId;
  const events = [];
  for await (const event of host.runChat("What decision did we make?")) events.push(event);

  assert.ok(events.some((event) => event.type === "done"));
  const remembered = memoryRequests.find((request) => request.url.endsWith("/remember/entry"));
  assert.equal(remembered?.body.session_id, sessionId);
  assert.equal(remembered?.body.dataset_name, "web-project");
  const entry = remembered?.body.entry as Record<string, unknown>;
  assert.match(String(entry.answer), /Provenance[\s\S]*Web memory stored\./);
  assert.equal((await listMemoryProvenance(workspace))[0]?.sessionId, sessionId);

  await host.newSession();
  const improved = memoryRequests.find((request) => request.url.endsWith("/improve"));
  assert.deepEqual(improved?.body.sessionIds, [sessionId]);
});
