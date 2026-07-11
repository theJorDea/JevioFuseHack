import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
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
