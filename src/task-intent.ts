const ENGLISH_IMPLEMENTATION = /\b(create|build|implement|write|add|fix|modify|refactor|make|replace|update)\b/i;
const RUSSIAN_IMPLEMENTATION = /созда(?:й|йте|ть)|сдела(?:й|йте|ть)|напиш(?:и|ите|ать)|добав(?:ь|ьте|ить)|исправ(?:ь|ьте|ить)|передела(?:й|йте|ть)|замен(?:и|ите|ить)|обнов(?:и|ите|ить)|сайт|страниц/iu;

export function isImplementationRequest(task: string): boolean {
  return ENGLISH_IMPLEMENTATION.test(task) || RUSSIAN_IMPLEMENTATION.test(task);
}
