import type { ChatMessage, ExecutionMode } from "./types.ts";

/**
 * Strong implementation verbs / constructions.
 * Avoid bare "make/update/write/add/fix" — too many false positives in Q&A.
 */
const ENGLISH_IMPLEMENTATION = /\b(?:create|build|implement|refactor|modify|replace|scaffold|wire\s+up|set\s+up|add\s+(?:a|an|the|new)\b|fix\s+(?:the\s+)?(?:bug|issue|error|typo|test|code|file|diff|regression)|\bfix\s+\S+|rename\s+\S+|write\s+(?:a|an|the|new)\s+(?!short\s+)?(?!explanation|summary|description|overview|answer|response)\w+|make\s+(?:a|an|the|new)\s+(?!sense\b)(?!sure\b)\w+|update\s+(?:the\s+)?(?:code|file|config|styles?|tests?|readme|docs?|package|version|api|ui|page|component|images?))\b/i;
const RUSSIAN_IMPLEMENTATION = /созда(?:й|йте|ть)|сдела(?:й|йте|ть)\s+(?:мне\s+)?(?:сайт|страниц|компонент|модуль|эндпоинт|фич|кнопк|форм)|(?:по)?дела(?:й|йте|ть)\s+(?:сайт|страниц|компонент)|напиш(?:и|ите|ать)\s+(?:код|файл|тест|скрипт|компонент|страниц)|добав(?:ь|ьте|ить)\s+(?:в\s+)?(?:код|файл|проект|репо)|исправ(?:ь|ьте|ить)|передела(?:й|йте|ть)|переименуй|замен(?:и|ите|ить)\s+(?:в\s+)?(?:код|файл|стиле|картинк)|обнов(?:и|ите|ить)\s+(?:код|файл|стиле|стили|версию|конфиг|пакет|картинк)|реализ(?:уй|уйте|овать)|выполн(?:и|ите|ять)\s+(?:план|задач|правки)|исполн(?:и|ите|ять)\s+(?:план|код)|сайт\s+(?:по|для|на)|лендинг|landing\s+page/iu;

/** Explicit "don't edit" / analysis-only cues that override weak implementation matches. */
const ANALYSIS_ONLY = /\b(?:explain|explanation|describe|description|what\s+does|how\s+does|why\s+does|walk\s+me\s+through|summarize|summary|list|show\s+me|tell\s+me|help\s+me\s+understand|make\s+sense\s+of|update\s+me\s+on|fix\s+my\s+understanding)\b|объясн|расскаж|как\s+работа|что\s+делает|зачем|почему|перечисл|покажи|опиши|без\s+правок|только\s+анализ|не\s+меняй|не\s+трогай\s+код|do\s+not\s+(?:edit|change|modify)|without\s+(?:editing|changing|modifying)/iu;

const CONTINUATION = /^(?:давай(?:\s+(?:дальше|продолжай|делай|реализуй|выполняй|ещё|еще))?|продолжай|поехали|go ahead|continue|proceed|try again|ещё раз|еще раз|retry)(?:\s+[.!?]*)?$/iu;

export type ModeConfidence = "low" | "medium" | "high";

export interface ModeRecommendation {
 mode: ExecutionMode;
 reason: string;
 confidence: ModeConfidence;
 /** Host may auto-apply for this task without asking. */
 auto: boolean;
}

function hasDirectImplementationIntent(task: string): boolean {
 const text = task.trim();
 if (!text) return false;
 // Analysis-first phrasing wins unless the user also clearly demands edits.
 if (ANALYSIS_ONLY.test(text) && !/\b(?:and\s+then\s+implement|потом\s+сделай|и\s+реализуй|и\s+исправь)\b/i.test(text)) {
 return false;
 }
 return ENGLISH_IMPLEMENTATION.test(text) || RUSSIAN_IMPLEMENTATION.test(text);
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

export interface ClarificationNeed {
 needed: boolean;
 reason: string;
 /** Short topics the host suggests covering in ask_user. */
 topics: string[];
}

/**
 * Detect underspecified product/implementation requests where inventing a choice
 * is worse than calling ask_user first.
 */
export function needsUserClarification(task: string, history: ChatMessage[] = []): ClarificationNeed {
 const text = task.trim();
 if (!text || ANALYSIS_ONLY.test(text)) {
 return { needed: false, reason: "", topics: [] };
 }

 // User already answered a form this turn chain — don't re-nudge aggressively.
 if (history.some((message) => message.role === "user" && /^(?:q\d+|layout|theme|stack|style)\s*:/im.test(message.content))) {
 return { needed: false, reason: "prior answers present", topics: [] };
 }

 const topics: string[] = [];
 const impl = isImplementationRequest(text, history);

 const openEndedUi = score(text, [
 /\b(landing|portfolio|marketing\s+page|website|web\s+app|dashboard|ui|ux)\b/i,
 /сайт|лендинг|портфолио|интерфейс|дизайн|страниц|магазин|витрин/iu,
 /\b(modern|beautiful|nice|cool|pretty|slick)\b/i,
 /красив|современн|стилн|минимал|премиум|вау/iu,
 ]);
 if (openEndedUi >= 2 || (openEndedUi >= 1 && impl && text.length < 220)) {
 topics.push("visual style / layout", "color & typography", "sections / content");
 }

 const missingStack = score(text, [
 /\b(app|project|service|api|backend|frontend|full[- ]?stack)\b/i,
 /приложен|сервис|бэкенд|фронт|с\s+нуля|greenfield|новый\s+проект/iu,
 ]) >= 1 && !/\b(react|vue|svelte|next|nuxt|express|fastapi|django|rails|go|rust|python|typescript|node|html|css)\b/i.test(text)
 && !/react|vue|svelte|next|html|css|python|node|typescript/iu.test(text);
 if (missingStack && impl) topics.push("tech stack");

 const eitherOr = score(text, [
 /\b(or|either|whether)\b/i,
 /\b(A|B)\s+or\s+(A|B)\b/i,
 /\sили\s|либо|вариант[аы]?|на\s+выбор/iu,
 ]);
 if (eitherOr >= 1) topics.push("explicit choice between alternatives");

 const vagueScope = score(text, [
 /\b(something|somehow|whatever|any|maybe|perhaps|i\s+guess|as\s+you\s+(?:see|want|think))\b/i,
 /что[- ]?нибудь|как\s+считаешь|на\s+тво[её]м\s+усмотрен|не\s+знаю|может\s+быть|примерно|типа/iu,
 ]);
 if (vagueScope >= 1 && impl) topics.push("scope and acceptance criteria");

 const productFork = score(text, [
 /\b(auth|payment|billing|notification|theme|dark\s+mode|i18n|locale)\b/i,
 /авториз|оплат|биллинг|уведомлен|тёмн|темн\s*режим|локализ/iu,
 ]) >= 1 && impl && text.length < 160;
 if (productFork) topics.push("product defaults (auth/theme/etc.)");

 // Deduplicate topics
 const unique = [...new Set(topics)];
 if (!unique.length) {
 return { needed: false, reason: "", topics: [] };
 }

 return {
 needed: true,
 reason: impl
 ? "Implementation request leaves product/design choices underspecified."
 : "Task involves open product choices.",
 topics: unique.slice(0, 5),
 };
}

/** Host block prepended to the user task so the model must use ask_user. */
export function formatAskUserNudge(need: ClarificationNeed): string {
 if (!need.needed) return "";
 const topics = need.topics.map((topic) => `- ${topic}`).join("\n");
 return [
 "HOST REQUIREMENT — use ask_user BEFORE writing files or claiming a design decision:",
 need.reason,
 "Cover these topics with 2–5 concrete options each (multi_select when several can apply):",
 topics,
 "Do NOT invent the user's taste, stack, or product defaults. Call ask_user first, wait for answers, then implement.",
 "If the workspace already hard-codes the only reasonable choice, you may skip that topic — say so briefly after tools.",
 "",
 ].join("\n");
}

/**
 * Recommend an execution mode for the user task.
 * Used for host auto-routing when sticky mode is `orchestrate`.
 *
 * Policy: only `auto: true` when confidence is high (or explicit command).
 * Medium suggestions stay for orchestrator suggest_mode / UI hints, not blind host apply.
 */
export function recommendExecutionMode(task: string, history: ChatMessage[] = []): ModeRecommendation {
 const text = task.trim();
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
 if (reviewScore >= 2) {
 return {
 mode: "council-review",
 reason: "Задача похожа на независимое ревью / аудит изменений.",
 confidence: "high",
 auto: true,
 };
 }
 if (reviewScore >= 1 && !impl) {
 return {
 mode: "council-review",
 reason: "Задача похожа на ревью — подтверди /council-review или оставь orchestrate.",
 confidence: "medium",
 auto: false,
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
 reason: "Есть признаки архитектурных решений — можно /council-plan.",
 confidence: "medium",
 auto: false,
 };
 }

 const teamScore = score(text, [
 /\b(feature|end[- ]to[- ]end|with\s+tests|full\s+stack|api\s+and\s+ui)\b/i,
 /фич[ауи]|полный\s+цикл|с\s+тестами|и\s+ui|и\s+фронт|эндпоинт.*тест/iu,
 /\b(implement|build|create).{0,40}(and|with).{0,20}(test|review|docs)/i,
 /реализуй.{0,40}(тест|провер|ревью)/iu,
 ]);
 if (teamScore >= 2) {
 return {
 mode: "team",
 reason: "Нетривиальная фича — architect → coder → reviewer.",
 confidence: "high",
 auto: true,
 };
 }
 if (teamScore >= 1 && impl && text.length > 80) {
 return {
 mode: "team",
 reason: "Похоже на feature-задачу — можно /team.",
 confidence: "medium",
 auto: false,
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
 confidence: "high",
 auto: true,
 };
 }

 if (impl && text.length > 200) {
 return {
 mode: "team",
 reason: "Длинный implementation-запрос — team pipeline безопаснее.",
 confidence: "medium",
 auto: false,
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
