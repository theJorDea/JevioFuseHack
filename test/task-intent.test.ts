import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAskUserNudge,
  isImplementationRequest,
  needsUserClarification,
  recommendExecutionMode,
} from "../src/task-intent.ts";

test("detects implementation requests in English and Russian", () => {
  assert.equal(isImplementationRequest("Build a modern storefront"), true);
  assert.equal(isImplementationRequest("Сделай современный сайт по продаже тапков"), true);
  assert.equal(isImplementationRequest("Замени картинки в стилях и обнови стили"), true);
  assert.equal(isImplementationRequest("Create a new login page component"), true);
  assert.equal(isImplementationRequest("Fix the bug in session loading"), true);
  assert.equal(isImplementationRequest("Объясни архитектуру проекта"), false);
});

test("does not treat Q&A / analysis as implementation", () => {
  assert.equal(isImplementationRequest("make sense of the orchestrator flow"), false);
  assert.equal(isImplementationRequest("update me on how memory works"), false);
  assert.equal(isImplementationRequest("write a short explanation of roles"), false);
  assert.equal(isImplementationRequest("add context: what does loadConfig do?"), false);
  assert.equal(isImplementationRequest("fix my understanding of plan mode"), false);
  assert.equal(isImplementationRequest("какие страницы есть в проекте"), false);
  assert.equal(isImplementationRequest("расскажи про сайт и страницы"), false);
  assert.equal(isImplementationRequest("How does create work in the CLI?"), false);
  assert.equal(isImplementationRequest("Explain the architecture without editing"), false);
});

test("uses session context for short implementation continuations", () => {
  const history = [
    { role: "user" as const, content: "Сделай современный сайт по продаже тапков" },
    { role: "assistant" as const, content: "Ошибка: файлы не были изменены." },
  ];

  assert.equal(isImplementationRequest("давай делай", history), true);
  assert.equal(isImplementationRequest("давай дальше", history), true);
  assert.equal(isImplementationRequest("try again", history), true);
  assert.equal(isImplementationRequest("давай дальше"), false);
});

test("recommendExecutionMode routes architecture and review tasks", () => {
  const arch = recommendExecutionMode("Спроектируй architecture redesign multi-module auth system and migration");
  assert.equal(arch.mode, "council-plan");
  assert.equal(arch.auto, true);
  assert.equal(arch.confidence, "high");

  const review = recommendExecutionMode("Сделай security review и аудит текущего diff");
  assert.equal(review.mode, "council-review");
  assert.equal(review.auto, true);

  const explicit = recommendExecutionMode("please use council-plan for this");
  assert.equal(explicit.mode, "council-plan");
  assert.equal(explicit.confidence, "high");

  const simple = recommendExecutionMode("Fix typo in README title");
  assert.equal(simple.mode, "direct");
  assert.equal(simple.auto, true);

  const normal = recommendExecutionMode("What does loadConfig do?");
  assert.equal(normal.mode, "orchestrate");
  assert.equal(normal.auto, false);
});

test("needsUserClarification forces ask_user on vague UI / open choices", () => {
  const site = needsUserClarification("Сделай красивый современный сайт-лендинг");
  assert.equal(site.needed, true);
  assert.ok(site.topics.length >= 1);
  assert.match(formatAskUserNudge(site), /HOST REQUIREMENT/);
  assert.match(formatAskUserNudge(site), /ask_user BEFORE/);

  const either = needsUserClarification("Implement dark mode or light mode for the settings page");
  assert.equal(either.needed, true);

  const precise = needsUserClarification("Fix typo in README title");
  assert.equal(precise.needed, false);

  const explain = needsUserClarification("Объясни как работает loadConfig");
  assert.equal(explain.needed, false);
});

test("medium-confidence recommendations do not auto-apply", () => {
  // Single architecture cue + implement → medium, not blind council-plan.
  const weakArch = recommendExecutionMode("Implement auth system for the app");
  assert.equal(weakArch.mode, "council-plan");
  assert.equal(weakArch.confidence, "medium");
  assert.equal(weakArch.auto, false);

  // Long implement without strong team cues → medium team or orchestrate, not auto.
  const longImpl = recommendExecutionMode(
    "Implement a comprehensive settings panel with user preferences, theme toggle, notification options, and export/import of configuration data across the application",
  );
  assert.ok(longImpl.mode === "team" || longImpl.mode === "orchestrate");
  if (longImpl.mode === "team") {
    assert.equal(longImpl.auto, false);
  }
});
