import assert from "node:assert/strict";
import test from "node:test";
import { isImplementationRequest } from "../src/task-intent.ts";

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
