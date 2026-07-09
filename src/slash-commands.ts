export interface SlashCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "help", description: "Show available commands" },
  { name: "new", description: "Start a new session" },
  { name: "sessions", description: "Browse saved sessions" },
  { name: "resume", description: "Resume a session by ID", argumentHint: "<id>" },
  { name: "title", description: "Show or change the session title", argumentHint: "[text]" },
  { name: "fork", description: "Fork the current session" },
  { name: "export-md", description: "Export the transcript", argumentHint: "[path]" },
  { name: "compact", description: "Compact the current context", argumentHint: "[status|instruction]" },
  { name: "team", description: "Use architect, coder, and reviewer" },
  { name: "direct", description: "Use the coder directly" },
  { name: "orchestrate", description: "Return to orchestration mode" },
  { name: "memory", description: "View or edit project memory", argumentHint: "[add|clear]" },
  { name: "exit", description: "Close Jevio" },
];

export function findSlashCommands(input: string): SlashCommandDefinition[] {
  const query = input.trim().replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}
