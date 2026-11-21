import type { ChatMessage, ExecutionMode } from "./types.ts";

const ENGLISH_IMPLEMENTATION = /\b(create|build|implement|write|add|fix|modify|refactor|make|replace|update|execute)\b/i;
const RUSSIAN_IMPLEMENTATION = /созда(?:й|йте|ть)|сдела(?:й|йте|ть)|(?:по)?дела(?:й|йте|ть)|напиш(?:и|ите|ать)|добав(?:ь|ьте|ить)|исправ(?:ь|ьте|ить)|передела(?:й|йте|ть)|замен(?:и|ите|ить)|обнов(?:и|ите|ить)|реализ(?:уй|уйте|овать)|выполн(?:и|ите|ять)|исполн(?:и|ите|ять)|сайт|страниц/iu;
const CONTINUATION = /^(?:давай(?:\s+(?:дальше|продолжай|делай|реализуй|выполняй))?|продолжай|поехали|go ahead|continue|proceed)(?:\s+[.!?]*)?$/iu;

export type ModeConfidence = "low" | "medium" | "high";

export interface ModeRecommendation {
  mode: ExecutionMode;
  reason: string;
  confidence: ModeConfidence;
  /** Host may auto-apply for this task without asking. */
  auto: boolean;
}

function hasDirectImplementationIntent(task: string): boolean {
  return ENGLISH_IMPLEMENTATION.test(task) || RUSSIAN_IMPLEMENTATION.test(task);
}

export function isImplementationRequest(task: string, history: ChatMessage[] = []): boolean {
  if (hasDirectImplementationIntent(task)) return true;
  if (!CONTINUATION.test(task.trim())) return false;

  const previousUserMessage = history.findLast((message) => message.role === "user");
  return previousUserMessage ? hasDirectImplementationIntent(previousUserMessage.content) : false;
}

function score(text: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);
}

/**
 * Recommend an execution mode for the user task.
 * Used for host auto-routing when sticky mode is `orchestrate`.
 */
export function recommendExecutionMode(task: string, history: ChatMessage[] = []): ModeRecommendation {
  const text = task.trim();
  const lower = text.toLowerCase();
  const impl = isImplementationRequest(text, history);

  // Explicit user force wins.
  if (/\b(?:use\s+)?council[- ]?plan\b|совет\s+архитект|\/council-plan/i.test(text)) {
    return { mode: "council-plan", reason: "В запросе явно нужен council-plan.", confidence: "high", auto: true };
  }
  if (/\b(?:use\s+)?council[- ]?review\b|совет\s+ревью|\/council-review/i.test(text)) {
    return { mode: "council-review", reason: "В запросе явно нужен council-review.", confidence: "high", auto: true };
  }
  if (/\b(?:use\s+)?team\s+mode\b|режиме?\s+team|\/team\b/i.test(text)) {
    return { mode: "team", reason: "В запросе явно нужен team pipeline.", confidence: "high", auto: true };
  }
  if (/\b(?:use\s+)?direct\b|напрямую|только\s+coder|\/direct\b/i.test(text)) {
    return { mode: "direct", reason: "В запросе явно нужен direct/coder.", confidence: "high", auto: true };
  }
  if (/\bplan\s+first\b|сначала\s+план|только\s+план|без\s+правок|\/plan\b/i.test(text) && !/\bthen\s+implement|потом\s+сделай|и\s+реализуй/i.test(text)) {
    return { mode: "plan", reason: "Нужен план без правок.", confidence: "high", auto: true };
  }

  const reviewScore = score(text, [
    /\b(review|audit|security\s+review|code\s+review|inspect\s+diff|check\s+the\s+diff)\b/i,
    /ревью|аудит|проверь\s+(код|дифф|изменения|pr)|security|уязвим/iu,
    /\b(findings|verdict|risks?)\b/i,
  ]);
  if (reviewScore >= 2 || (reviewScore >= 1 && !impl)) {
    return {
      mode: "council-review",
      reason: "Задача похожа на независимое ревью / аудит изменений.",
      confidence: reviewScore >= 2 ? "high" : "medium",
      auto: true,
    };
  }

  const architectureScore = score(text, [
    /\b(architect(?:ure)?|redesign|migrate|migration|multi[- ]module|cross[- ]cutting|system\s+design)\b/i,
    /архитектур|перепроект|миграц|спроектируй|спроектировать|рефакторинг\s+всей|с\s+нуля\s+спроектир/iu,
    /\b(auth(entication|orization)?\s+system|payment|billing|multi[- ]tenant)\b/i,
    /систем[аы]\s+авториза|платёжн|биллинг|несколько\s+сервис/iu,
  ]);
  if (architectureScore >= 2) {
    return {
      mode: "council-plan",
      reason: "Сложная архитектурная задача — лучше совет архитекторов.",
      confidence: "high",
      auto: true,
    };
  }
  if (architectureScore >= 1 && impl) {
    return {
      mode: "council-plan",
      reason: "Есть признаки архитектурных решений при реализации.",
      confidence: "medium",
      auto: true,
    };
  }

  const teamScore = score(text, [
    /\b(feature|end[- ]to[- ]end|with\s+tests|full\s+stack|api\s+and\s+ui)\b/i,
    /фич[ауи]|полный\s+цикл|с\s+тестами|и\s+ui|и\s+фронт|эндпоинт.*тест/iu,
    /\b(implement|build|create).{0,40}(and|with).{0,20}(test|review|docs)/i,
    /реализуй.{0,40}(тест|провер|ревью)/iu,
  ]);
  if (teamScore >= 2 || (teamScore >= 1 && impl && text.length > 80)) {
    return {
      mode: "team",
      reason: "Нетривиальная фича — architect → coder → reviewer.",
      confidence: teamScore >= 2 ? "high" : "medium",
      auto: true,
    };
  }

  const simpleScore = score(text, [
    /\b(typo|rename|wording|comment|css\s+color|bump\s+version|one[- ]line)\b/i,
    /опечатк|переименуй|комментар|цвет|версию|одну\s+строк|мелоч/iu,
    /^(fix|исправь)\s+\S+/i,
  ]);
  if (simpleScore >= 1 && text.length < 120 && impl) {
    return {
      mode: "direct",
      reason: "Похоже на мелкую правку — достаточно coder.",
      confidence: "medium",
      auto: true,
    };
  }

  if (impl && text.length > 200) {
    return {
      mode: "team",
      reason: "Длинный implementation-запрос — безопаснее team pipeline.",
      confidence: "medium",
      auto: true,
    };
  }

  // Default: keep dynamic orchestration.
  return {
    mode: "orchestrate",
    reason: "Обычная задача — динамический orchestrator.",
    confidence: "low",
    auto: false,
  };
}
