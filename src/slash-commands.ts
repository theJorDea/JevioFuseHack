export type SlashCommandGroup =
  | "session"
  | "models"
  | "mode"
  | "memory"
  | "tools"
  | "system";

export interface SlashCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  group: SlashCommandGroup;
  /** Hidden aliases still work when typed. */
  aliases?: string[];
  /** Show in Ctrl+K palette (default true). */
  palette?: boolean;
}

const GROUP_ORDER: SlashCommandGroup[] = [
  "session",
  "models",
  "mode",
  "memory",
  "tools",
  "system",
];

const GROUP_LABEL: Record<SlashCommandGroup, string> = {
  session: "Сессия",
  models: "Модели",
  mode: "Режим",
  memory: "Память",
  tools: "Инструменты",
  system: "Система",
};

/**
 * Canonical slash commands. Keep this list short and intentional.
 * Aliases work but stay out of the palette/help unless listed as primary.
 */
export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  // session
  { name: "new", description: "Новая сессия", group: "session", aliases: ["reset"] },
  { name: "sessions", description: "Список и переключение сессий", group: "session", aliases: ["session"] },
  { name: "resume", description: "Продолжить сессию по id", argumentHint: "<id>", group: "session" },
  { name: "title", description: "Название сессии", argumentHint: "[текст]", group: "session", aliases: ["rename"] },
  { name: "fork", description: "Копия текущей сессии", group: "session" },
  { name: "export-md", description: "Экспорт истории в Markdown", argumentHint: "[путь]", group: "session", aliases: ["export"] },
  { name: "compact", description: "Сжать контекст", argumentHint: "[status|инструкция]", group: "session" },
  {
    name: "clear",
    description: "Очистить экран TUI (сессию не трогает)",
    group: "session",
    // Not in palette — easy to confuse with /new; still works when typed in TUI.
    palette: false,
  },

  // models
  { name: "provider", description: "Провайдер (список / смена)", argumentHint: "[имя]", group: "models" },
  { name: "models", description: "Модель на все роли", argumentHint: "[status|id]", group: "models", aliases: ["model"] },
  { name: "roles", description: "Модель/провайдер на каждую роль", group: "models" },
  { name: "setup", description: "Статус окружения + провайдер", group: "models" },
  { name: "yolo", description: "Auto-approve writes/shell/plugins/plans", argumentHint: "[on|off|status]", group: "models" },

  // mode
  { name: "direct", description: "Только coder", group: "mode" },
  { name: "orchestrate", description: "Динамическая оркестрация", group: "mode" },
  { name: "team", description: "architect → coder → reviewer", group: "mode" },
  { name: "plan", description: "Plan Mode (read-only → submit_plan)", group: "mode" },
  { name: "council-plan", description: "Совет архитекторов → coder", group: "mode" },
  { name: "council-review", description: "Совет ревьюеров", group: "mode" },
  {
    name: "auto-mode",
    description: "Авто-выбор team/council/plan под задачу",
    argumentHint: "[on|off|status]",
    group: "mode",
    aliases: ["autoroute"],
  },

  // memory
  { name: "memory", description: "Память проекта (MEMORY.md / Cognee)", argumentHint: "[add|status|explain|sync|improve|clear]", group: "memory" },
  { name: "dream", description: "Консолидация сессий → MEMORY.md", argumentHint: "[status|force]", group: "memory" },
  { name: "kairos", description: "Проактивный обзор workspace", argumentHint: "[status|full]", group: "memory" },

  // tools
  {
    name: "ideas",
    description: "Генератор идей по репозиторию",
    argumentHint: "[тема] · count=N",
    group: "tools",
    aliases: ["idea", "brainstorm"],
  },
  { name: "skills", description: "Список skills", group: "tools" },
  { name: "plugins", description: "MCP-плагины", group: "tools" },
  { name: "fix-review", description: "Исправить findings Council Review", group: "tools" },

  // system
  { name: "help", description: "Справка по командам", group: "system", aliases: ["h", "?"] },
  { name: "exit", description: "Выйти", group: "system", aliases: ["quit", "q"] },
];

export function getPrimaryCommands(): SlashCommandDefinition[] {
  return SLASH_COMMANDS.filter((command) => command.palette !== false);
}

export function findSlashCommands(input: string): SlashCommandDefinition[] {
  const query = input.trim().replace(/^\//, "").toLowerCase();
  if (!query) return getPrimaryCommands();
  const matched = new Map<string, SlashCommandDefinition>();
  for (const command of SLASH_COMMANDS) {
    if (command.name.startsWith(query)) {
      matched.set(command.name, command);
      continue;
    }
    for (const alias of command.aliases ?? []) {
      if (alias.startsWith(query)) {
        // Prefer showing the primary name for autocomplete.
        matched.set(command.name, command);
        break;
      }
    }
  }
  return [...matched.values()];
}

export function resolveSlashCommand(input: string): SlashCommandDefinition | undefined {
  const token = input.trim().split(/\s+/)[0]?.replace(/^\//, "").toLowerCase() ?? "";
  if (!token) return undefined;
  for (const command of SLASH_COMMANDS) {
    if (command.name === token) return command;
    if (command.aliases?.includes(token)) return command;
  }
  return undefined;
}

export function isExactSlashCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) return false;
  if (/\s/.test(normalized)) return false;
  return Boolean(resolveSlashCommand(normalized));
}

/** Grouped command list for Ctrl+K palette. */
export function getPaletteItems(): Array<{ value: string; label: string; description: string }> {
  const items: Array<{ value: string; label: string; description: string }> = [];
  for (const group of GROUP_ORDER) {
    const commands = getPrimaryCommands().filter((command) => command.group === group);
    if (!commands.length) continue;
    for (const command of commands) {
      items.push({
        value: `/${command.name}`,
        label: `/${command.name}`,
        description: `${GROUP_LABEL[group]} · ${command.description}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      });
    }
  }
  return items;
}

/** Compact, grouped interactive help (no alias spam). */
export function formatInteractiveHelp(): string {
  const lines = ["Команды Fuse (основные):", ""];
  for (const group of GROUP_ORDER) {
    const commands = getPrimaryCommands().filter((command) => command.group === group);
    if (!commands.length) continue;
    lines.push(`${GROUP_LABEL[group]}:`);
    for (const command of commands) {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      lines.push(`  /${command.name}${hint.padEnd(22 - command.name.length)}  ${command.description}`);
    }
    lines.push("");
  }
  lines.push("Подсказки:");
  lines.push("  /new — новая сессия · /clear — только очистить экран TUI");
  lines.push("  /provider + /models — всем ролям · /roles — по ролям");
  lines.push("  /yolo — auto-approve · Ctrl+K — палитра · Ctrl+O — свернуть блоки");
  return lines.join("\n");
}
