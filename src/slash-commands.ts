export interface SlashCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "help", description: "Показать доступные команды" },
  { name: "new", description: "Начать новую сессию" },
  { name: "sessions", description: "Открыть сохраненные сессии" },
  { name: "resume", description: "Продолжить сессию по ID", argumentHint: "<id>" },
  { name: "title", description: "Показать или изменить название сессии", argumentHint: "[текст]" },
  { name: "fork", description: "Создать копию текущей сессии" },
  { name: "export-md", description: "Экспортировать историю", argumentHint: "[путь]" },
  { name: "compact", description: "Сжать текущий контекст", argumentHint: "[статус|инструкция]" },
  { name: "provider", description: "Выбрать провайдера модели", argumentHint: "[имя]" },
  { name: "team", description: "Использовать architect, coder и reviewer" },
  { name: "council-plan", description: "Запустить совет архитекторов для сложной задачи" },
  { name: "council-review", description: "Запустить совет ревьюеров текущих изменений" },
  { name: "direct", description: "Работать напрямую через coder" },
  { name: "orchestrate", description: "Вернуться в режим оркестрации" },
  { name: "memory", description: "Просмотреть или изменить память проекта", argumentHint: "[add|clear]" },
  { name: "exit", description: "Выйти из Fuse" },
];

export function findSlashCommands(input: string): SlashCommandDefinition[] {
  const query = input.trim().replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

export function isExactSlashCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return SLASH_COMMANDS.some((command) => normalized === `/${command.name}`);
}
