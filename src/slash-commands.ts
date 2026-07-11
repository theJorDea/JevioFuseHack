export type SlashCommandGroup =
  | "session"
  | "models"
  | "mode"
  | "memory"
  | "tools"
  | "system";

export interface SlashSubcommand {
  name: string;
  description: string;
  /** Optional trailing arg hint shown after the subcommand name. */
  argumentHint?: string;
}

export interface SlashCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  group: SlashCommandGroup;
  /** Hidden aliases still work when typed. */
  aliases?: string[];
  /** Show in Ctrl+K palette (default true). */
  palette?: boolean;
  /** Known first-token subcommands for autocomplete and help. */
  subcommands?: SlashSubcommand[];
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
  {
    name: "compact",
    description: "Сжать контекст",
    argumentHint: "[status|инструкция]",
    group: "session",
    subcommands: [
      { name: "status", description: "Показать настройки сжатия и оценку контекста" },
    ],
  },
  {
    name: "clear",
    description: "Очистить экран TUI (сессию не трогает)",
    group: "session",
    // Not in palette — easy to confuse with /new; still works when typed in TUI.
    palette: false,
  },

  // models
  { name: "provider", description: "Провайдер (список / смена)", argumentHint: "[имя]", group: "models" },
  {
    name: "models",
    description: "Модель на все роли",
    argumentHint: "[status|id]",
    group: "models",
    aliases: ["model"],
    subcommands: [
      { name: "status", description: "Текущая модель / провайдер" },
    ],
  },
  { name: "roles", description: "Модель/провайдер на каждую роль", group: "models" },
  { name: "setup", description: "Статус окружения + провайдер", group: "models" },
  {
    name: "yolo",
    description: "Auto-approve writes/shell/plugins/plans",
    argumentHint: "[on|off|status]",
    group: "models",
    subcommands: [
      { name: "on", description: "Включить YOLO" },
      { name: "off", description: "Выключить YOLO" },
      { name: "status", description: "Показать состояние YOLO" },
    ],
  },

  // mode — with optional task: sets sticky mode and runs the task immediately
  { name: "direct", description: "Только coder", argumentHint: "[задача]", group: "mode" },
  { name: "orchestrate", description: "Динамическая оркестрация", argumentHint: "[задача]", group: "mode" },
  { name: "team", description: "architect → coder → reviewer", argumentHint: "[задача]", group: "mode" },
  { name: "plan", description: "Plan Mode (read-only → submit_plan)", argumentHint: "[задача]", group: "mode" },
  { name: "council-plan", description: "Совет архитекторов → coder", argumentHint: "[задача]", group: "mode" },
  { name: "council-review", description: "Совет ревьюеров", argumentHint: "[задача]", group: "mode" },
  {
    name: "auto-mode",
    description: "Auto только high-confidence team/council/plan/direct",
    argumentHint: "[on|off|status]",
    group: "mode",
    aliases: ["autoroute"],
    subcommands: [
      { name: "on", description: "Включить auto-route" },
      { name: "off", description: "Выключить auto-route" },
      { name: "status", description: "Статус auto-route" },
    ],
  },

  // memory
  {
    name: "memory",
    description: "Память проекта (MEMORY.md / Cognee)",
    argumentHint: "[add|status|explain|sync|improve|clear|show]",
    group: "memory",
    subcommands: [
      { name: "show", description: "Показать MEMORY.md" },
      { name: "add", description: "Добавить запись", argumentHint: "<текст>" },
      { name: "status", description: "Markdown + Cognee status" },
      { name: "explain", description: "Последний recall / provenance" },
      { name: "sync", description: "MEMORY.md → Cognee" },
      { name: "improve", description: "Обогатить граф Cognee" },
      { name: "clear", description: "Очистить память проекта" },
      { name: "help", description: "Справка по /memory" },
    ],
  },
  {
    name: "dream",
    description: "Консолидация сессий → MEMORY.md",
    argumentHint: "[status|force]",
    group: "memory",
    subcommands: [
      { name: "status", description: "Очередь / last dream" },
      { name: "force", description: "Пересобрать MEMORY.md" },
    ],
  },
  {
    name: "kairos",
    description: "Проактивный обзор workspace",
    argumentHint: "[status|full]",
    group: "memory",
    subcommands: [
      { name: "status", description: "Краткий статус сигналов" },
      { name: "full", description: "Полный отчёт + синтез" },
    ],
  },

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
  {
    name: "critique",
    description: "Критик кода: советы по diff после правок",
    argumentHint: "[fix|focus …]",
    group: "tools",
    aliases: ["review-diff", "critic"],
    subcommands: [
      { name: "fix", description: "Исправить critical findings из последнего critique" },
      { name: "focus", description: "Критика с фокусом", argumentHint: "<тема>" },
    ],
  },
  {
    name: "todos",
    description: "Показать / очистить live ToDo (update_todo)",
    argumentHint: "[clear]",
    group: "tools",
    aliases: ["todo"],
    subcommands: [
      { name: "clear", description: "Очистить checklist" },
      { name: "show", description: "Показать текущий ToDo" },
    ],
  },
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

export function getSubcommands(commandName: string): SlashSubcommand[] {
  const command = resolveSlashCommand(commandName);
  return command?.subcommands ?? [];
}

/** Filter subcommands by typed prefix after `/cmd `. */
export function completeSlashArguments(commandName: string, argumentPrefix: string): Array<{
  value: string;
  label: string;
  description?: string;
}> {
  const prefix = argumentPrefix.trim().toLowerCase();
  // Only complete the first token (subcommand). Free-text args stay free.
  const first = prefix.split(/\s+/)[0] ?? "";
  if (/\s/.test(argumentPrefix.trimEnd()) && argumentPrefix.trim().includes(" ")) {
    // User already picked a subcommand and is typing its payload — no list.
    const sub = getSubcommands(commandName).find((item) => item.name === first);
    if (sub?.argumentHint) return [];
    return [];
  }
  return getSubcommands(commandName)
    .filter((item) => !first || item.name.startsWith(first))
    .map((item) => ({
      value: item.name + (item.argumentHint ? " " : ""),
      label: item.name,
      description: item.argumentHint ? `${item.description} ${item.argumentHint}` : item.description,
    }));
}

/** Help text for a command that has subcommands (e.g. /memory). */
export function formatSubcommandHelp(commandName: string): string {
  const command = resolveSlashCommand(commandName);
  if (!command) return `Неизвестная команда: /${commandName}`;
  const subs = command.subcommands ?? [];
  const lines = [
    `/${command.name} — ${command.description}`,
    "",
  ];
  if (!subs.length) {
    lines.push(command.argumentHint ? `Использование: /${command.name} ${command.argumentHint}` : `Использование: /${command.name}`);
    return lines.join("\n");
  }
  lines.push("Подкоманды:");
  for (const sub of subs) {
    const hint = sub.argumentHint ? ` ${sub.argumentHint}` : "";
    lines.push(`  /${command.name} ${sub.name}${hint.padEnd(Math.max(2, 16 - sub.name.length))}  ${sub.description}`);
  }
  if (command.name === "memory") {
    lines.push("");
    lines.push("Без аргументов: показать MEMORY.md (как /memory show).");
    lines.push("Также: /dream · /kairos");
  }
  return lines.join("\n");
}

/** SlashCommand objects for pi-tui CombinedAutocompleteProvider (incl. arg completion). */
export function getAutocompleteSlashCommands(): Array<{
  name: string;
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
}> {
  return SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    getArgumentCompletions: command.subcommands?.length
      ? (argumentPrefix: string) => {
        const items = completeSlashArguments(command.name, argumentPrefix);
        return items.length ? items : null;
      }
      : undefined,
  }));
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
  lines.push("Память (вторая часть команды):");
  lines.push("  /memory show|add|status|explain|sync|improve|clear");
  lines.push("  /dream status|force   ·  /kairos status|full");
  lines.push("");
  lines.push("Подсказки:");
  lines.push("  /new — новая сессия · /clear — только очистить экран TUI");
  lines.push("  /provider + /models — всем ролям · /roles — по ролям");
  lines.push("  /yolo — auto-approve · Tab после /memory — подкоманды");
  lines.push("  Ctrl+K — палитра · Ctrl+O — свернуть блоки · @ — файл");
  return lines.join("\n");
}
