import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskNotificationSequences, emitTaskNotification } from "../src/tui-notify.ts";

test("skips short successful turns", () => {
  assert.deepEqual(
    buildTaskNotificationSequences({ ok: true, body: "quick", durationMs: 500 }),
    [],
  );
});

test("notifies on long success and any failure", () => {
  const ok = buildTaskNotificationSequences({ ok: true, body: "Build landing", durationMs: 5_000 });
  assert.ok(ok.length >= 2);
  assert.equal(ok[0], "\x07");
  assert.ok(ok.some((item) => item.startsWith("\x1b]9;")));
  assert.ok(ok.some((item) => item.includes("]99;")));

  const fail = buildTaskNotificationSequences({ ok: false, body: "boom", durationMs: 100 });
  assert.ok(fail.length >= 2);
  assert.ok(fail.some((item) => item.includes("ошибка") || item.includes("Fuse")));
});

test("emitTaskNotification writes sequences", () => {
  const chunks: string[] = [];
  const wrote = emitTaskNotification((data) => chunks.push(data), {
    ok: true,
    body: "done",
    durationMs: 10_000,
  });
  assert.equal(wrote, true);
  assert.ok(chunks.join("").includes("\x07"));
});
