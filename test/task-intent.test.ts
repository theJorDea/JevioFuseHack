import assert from "node:assert/strict";
import test from "node:test";
import { isImplementationRequest, recommendExecutionMode } from "../src/task-intent.ts";

test("detects implementation requests in English and Russian", () => {
  assert.equal(isImplementationRequest("Build a modern storefront"), true);
  assert.equal(isImplementationRequest("Сделай современный сайт по продаже тапков"), true);
  assert.equal(isImplementationRequest("Замени картинки и обнови стили"), true);
  assert.equal(isImplementationRequest("Объясни архитектуру проекта"), false);
});

test("uses session context for short implementation continuations", () => {
  const history = [
    { role: "user" as const, content: "Сделай современный сайт по продаже тапков" },
    { role: "assistant" as const, content: "Ошибка: файлы не были изменены." },
  ];

  assert.equal(isImplementationRequest("давай делай", history), true);
  assert.equal(isImplementationRequest("давай дальше", history), true);
  assert.equal(isImplementationRequest("давай дальше"), false);
});

test("recommendExecutionMode routes architecture and review tasks", () => {
  const arch = recommendExecutionMode("Спроектируй architecture redesign multi-module auth system and migration");
  assert.equal(arch.mode, "council-plan");
  assert.equal(arch.auto, true);

  const review = recommendExecutionMode("Сделай security review и аудит текущего diff");
  assert.equal(review.mode, "council-review");
  assert.equal(review.auto, true);

  const explicit = recommendExecutionMode("please use council-plan for this");
  assert.equal(explicit.mode, "council-plan");
  assert.equal(explicit.confidence, "high");

  const simple = recommendExecutionMode("Fix typo in README title");
  assert.equal(simple.mode, "direct");

  const normal = recommendExecutionMode("What does loadConfig do?");
  assert.equal(normal.mode, "orchestrate");
  assert.equal(normal.auto, false);
});
