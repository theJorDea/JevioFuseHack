import type { ChatMessage } from "./types.ts";

const ENGLISH_IMPLEMENTATION = /\b(create|build|implement|write|add|fix|modify|refactor|make|replace|update|execute)\b/i;
const RUSSIAN_IMPLEMENTATION = /созда(?:й|йте|ть)|сдела(?:й|йте|ть)|(?:по)?дела(?:й|йте|ть)|напиш(?:и|ите|ать)|добав(?:ь|ьте|ить)|исправ(?:ь|ьте|ить)|передела(?:й|йте|ть)|замен(?:и|ите|ить)|обнов(?:и|ите|ить)|реализ(?:уй|уйте|овать)|выполн(?:и|ите|ять)|исполн(?:и|ите|ять)|сайт|страниц/iu;
const CONTINUATION = /^(?:давай(?:\s+(?:дальше|продолжай|делай|реализуй|выполняй))?|продолжай|поехали|go ahead|continue|proceed)(?:\s+[.!?]*)?$/iu;

function hasDirectImplementationIntent(task: string): boolean {
  return ENGLISH_IMPLEMENTATION.test(task) || RUSSIAN_IMPLEMENTATION.test(task);
}

export function isImplementationRequest(task: string, history: ChatMessage[] = []): boolean {
  if (hasDirectImplementationIntent(task)) return true;
  if (!CONTINUATION.test(task.trim())) return false;

  const previousUserMessage = history.findLast((message) => message.role === "user");
  return previousUserMessage ? hasDirectImplementationIntent(previousUserMessage.content) : false;
}
