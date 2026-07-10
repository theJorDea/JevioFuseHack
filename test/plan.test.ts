import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlanDocument, writePlanDocument } from "../src/plan.ts";

test("plan documents persist approval status and user feedback", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-plan-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const document = await createPlanDocument(workspace, "session-12345678");
  document.feedback.push("Добавить тест для ошибки сети");
  await writePlanDocument(document, "1. Изменить API\n2. Запустить тесты", "approved");
  const content = await readFile(document.path, "utf8");
  assert.match(content, /status: approved/);
  assert.match(content, /# План реализации/);
  assert.match(content, /Добавить тест для ошибки сети/);
});
