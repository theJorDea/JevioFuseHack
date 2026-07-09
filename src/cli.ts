#!/usr/bin/env node
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentEvent } from "./agent.ts";
import {
  compactConversation,
  estimateHistoryTokens,
  historyCharacters,
  needsAutoCompaction,
} from "./compaction.ts";
import { addProviderConfig, loadConfig } from "./config.ts";
import { runTeam } from "./orchestrator.ts";
import {
  appendProjectMemory,
  appendSessionCompaction,
  appendSessionTurn,
  clearProjectMemory,
  createSession,
  discardEmptySession,
  exportSession,
  forkSession,
  listSessions,
  loadProjectMemory,
  loadSession,
  NEW_SESSION_TITLE,
  renameSession,
  type LoadedSession,
  type SessionInfo,
} from "./session.ts";
import { discoverSkills } from "./skills.ts";
import { buildRepositoryMap, getCtagsStatus, prewarmSymbolIndex } from "./symbol-index.ts";
import { InteractiveTui } from "./interactive-tui.ts";
import type { ChatMessage, ToolContext } from "./types.ts";

interface CliOptions {
  command: "run" | "init" | "doctor" | "skills" | "help";
  task: string;
  workspace: string;
  configPath?: string;
  team: boolean;
  direct: boolean;
  yes: boolean;
  continueSession: boolean;
  sessionRequested: boolean;
  sessionId?: string;
}

const HELP = `Jevio - local-first coding agent

Usage:
  jevio [options] [task]       Run a task; without a task, start interactive mode
  jevio init                   Create jevio.config.json and a starter skill
  jevio doctor                 Check configuration and model endpoints
  jevio skills                 List discovered project skills

Options:
  --continue, -c               Resume the latest session in this workspace
  --session, -S [id]           Pick or resume a specific session
  --resume, -r [id]            Alias for --session
  --team                       Run architect -> coder -> reviewer pipeline
  --direct                     Use the coder directly without model orchestration
  --yes, -y                    Approve workspace writes and shell commands
  --workspace, -w <path>       Workspace directory (default: current directory)
  --config, -C <path>          Explicit configuration file
  --help, -h                   Show this help
`;

const INTERACTIVE_HELP = `Session commands:
  /new, /clear                 Start a fresh session
  /sessions, /session          Browse and switch sessions
  /resume [id]                 Resume a selected session
  /title [text], /rename       View or change the title
  /fork                        Fork the current session
  /export-md [path]            Export the current Markdown transcript
  /compact [instruction]       Compact context with the configured model
  /compact status              Show compaction settings and context estimate
  /provider [name]             Show or switch a configured provider for this session
  /team                        Use architect -> coder -> reviewer for next tasks
  /direct                      Use coder directly for next tasks
  /orchestrate                 Return to dynamic orchestration
  /memory                      Show project memory
  /memory add <text>           Append durable project memory
  /memory clear                Clear project memory
  /help                        Show commands
  /exit                        Exit
`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "run",
    task: "",
    workspace: process.cwd(),
    team: false,
    direct: false,
    yes: false,
    continueSession: false,
    sessionRequested: false,
  };
  const taskParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (index === 0 && ["init", "doctor", "skills"].includes(argument)) {
      options.command = argument as CliOptions["command"];
    } else if (argument === "--help" || argument === "-h") {
      options.command = "help";
    } else if (argument === "--continue" || argument === "-c") {
      options.continueSession = true;
    } else if (["--session", "--resume", "-S", "-r"].includes(argument)) {
      options.sessionRequested = true;
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith("-")) options.sessionId = argv[++index];
    } else if (argument === "--team") {
      options.team = true;
    } else if (argument === "--direct") {
      options.direct = true;
    } else if (argument === "--yes" || argument === "-y") {
      options.yes = true;
    } else if (argument === "--workspace" || argument === "-w") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a path.`);
      options.workspace = path.resolve(value);
    } else if (argument === "--config" || argument === "-C") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a path.`);
      options.configPath = value;
    } else if (index > 0 || options.command === "run") {
      taskParts.push(argument);
    }
  }
  if (options.continueSession && options.sessionRequested) {
    throw new Error("--continue and --session cannot be used together.");
  }
  options.task = taskParts.join(" ").trim();
  return options;
}

function eventReporter(event: AgentEvent): void {
  if (event.type === "tool") process.stderr.write(`  [${event.role}] ${event.detail}\n`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readPipedInput(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

async function initialize(workspace: string): Promise<void> {
  const configTarget = path.join(workspace, "jevio.config.json");
  const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "jevio.config.example.json");
  if (await exists(configTarget)) throw new Error("jevio.config.json already exists.");
  await copyFile(example, configTarget);

  const skillDirectory = path.join(workspace, ".agents", "skills", "project-conventions");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), `---
name: project-conventions
description: Project-specific architecture, style, testing, and delivery conventions
whenToUse: When writing, modifying, or reviewing code in this repository
type: prompt
---

# Project conventions

Replace this text with concrete instructions the coding agent should follow for this repository.
Keep the skill focused, actionable, and explicit about when it applies.
`, "utf8");
  console.log(`Created ${path.relative(process.cwd(), configTarget)} and starter skill.`);
}

async function makeContext(options: CliOptions, confirm: ToolContext["confirm"]): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>; context: ToolContext }> {
  const config = await loadConfig(options.workspace, options.configPath);
  const skills = await discoverSkills(options.workspace);
  return {
    config,
    context: {
      workspace: options.workspace,
      skills,
      projectMemory: await loadProjectMemory(options.workspace),
      codeIndex: config.codeIndex,
      autoApproveWrites: options.yes || config.permissions.autoApproveWorkspaceWrites,
      autoApproveShell: options.yes || config.permissions.autoApproveShell,
      maxToolOutputCharacters: config.agent.maxToolOutputCharacters,
      confirm,
    },
  };
}

async function doctor(options: CliOptions): Promise<void> {
  const config = await loadConfig(options.workspace, options.configPath);
  let failures = 0;
  if (config.codeIndex.enabled && config.codeIndex.backend !== "builtin") {
    const ctags = await getCtagsStatus();
    if (ctags.available) console.log(`OK   code index: ${ctags.detail}`);
    else if (config.codeIndex.backend === "ctags") {
      console.log(`FAIL code index: ${ctags.detail}`);
      failures += 1;
    } else {
      console.log(`WARN code index: ${ctags.detail}; using builtin fallback`);
    }
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    const key = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    if (provider.apiKeyEnv && !key) {
      console.log(`FAIL ${name}: missing ${provider.apiKeyEnv}`);
      failures += 1;
      continue;
    }
    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      console.log(`OK   ${name}: ${provider.baseUrl}`);
    } catch (error) {
      console.log(`FAIL ${name}: ${(error as Error).message}`);
      failures += 1;
    }
  }
  if (failures) process.exitCode = 1;
}

function printSessions(sessions: SessionInfo[]): void {
  if (!sessions.length) {
    console.log("No saved sessions in this workspace.");
    return;
  }
  sessions.forEach((session, index) => {
    const updated = session.updatedAt.replace("T", " ").slice(0, 16);
    console.log(`${String(index + 1).padStart(2)}. ${session.id}  ${updated}  ${session.title}`);
  });
}

async function pickSession(workspace: string, terminal: Interface): Promise<LoadedSession | null> {
  const sessions = await listSessions(workspace);
  printSessions(sessions);
  if (!sessions.length || !process.stdin.isTTY) return null;
  const answer = (await terminal.question("Session number or ID (empty to cancel): ")).trim();
  if (!answer) return null;
  const numbered = Number.parseInt(answer, 10);
  const requested = Number.isInteger(numbered) && String(numbered) === answer
    ? sessions[numbered - 1]?.id
    : answer;
  if (!requested) throw new Error("Invalid session selection.");
  return loadSession(workspace, requested);
}

async function initialSession(options: CliOptions, terminal?: Interface): Promise<LoadedSession> {
  if (options.continueSession) {
    const sessions = await listSessions(options.workspace);
    return sessions.length ? loadSession(options.workspace, "latest") : { info: await createSession(options.workspace), history: [] };
  }
  if (options.sessionRequested) {
    if (options.sessionId) return loadSession(options.workspace, options.sessionId);
    const picked = terminal ? await pickSession(options.workspace, terminal) : null;
    if (picked) return picked;
  }
  return { info: await createSession(options.workspace), history: [] };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    console.log(HELP);
    return;
  }
  if (options.command === "init") {
    await initialize(options.workspace);
    return;
  }
  if (options.command === "doctor") {
    await doctor(options);
    return;
  }
  if (options.command === "skills") {
    const skills = await discoverSkills(options.workspace);
    if (!skills.length) console.log("No skills found. Run jevio init to create a starter skill.");
    for (const skill of skills) console.log(`${skill.name}\t${skill.description}`);
    return;
  }

  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let tui: InteractiveTui | undefined;
  const confirm = async (message: string): Promise<boolean> => {
    if (tui) return tui.confirm(message);
    if (!terminal) return false;
    const answer = await terminal.question(`${message} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  };
  const { config, context } = await makeContext(options, confirm);
  void prewarmSymbolIndex(options.workspace, config.codeIndex).catch((error) => {
    process.stderr.write(`  [symbol-index] background prewarm failed: ${(error as Error).message}\n`);
  });
  const reportEvent = (event: AgentEvent): void => {
    if (tui) tui.reportEvent(event);
    else eventReporter(event);
  };
  context.delegate = async (role, task) => {
    const result = await runAgent({ role, task, config, toolContext: context, onEvent: reportEvent });
    return result.content;
  };

  let active = await initialSession(options, terminal);
  let history = active.history;
  let mode: "team" | "direct" | "orchestrate" = options.team
    ? "team"
    : options.direct
      ? "direct"
      : "orchestrate";
  const currentProvider = (): string => {
    const providers = new Set(Object.values(config.roles).map((role) => role.provider ?? config.defaultProvider));
    return providers.size === 1 ? [...providers][0] : "mixed";
  };
  const selectProvider = (name: string): string => {
    if (!config.providers[name]) throw new Error(`Unknown provider '${name}'. Add it to jevio.config.json first.`);
    for (const role of Object.values(config.roles)) role.provider = name;
    return `Provider: ${name}. Applied to every role for this session; role model names remain unchanged.`;
  };
  const addProvider = async (provider: { name: string; baseUrl: string; apiKeyEnv?: string; model: string }): Promise<string> => {
    const file = await addProviderConfig(options.workspace, options.configPath, provider);
    config.providers[provider.name] = {
      baseUrl: provider.baseUrl.replace(/\/$/, ""),
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    };
    for (const role of Object.values(config.roles)) {
      role.provider = provider.name;
      role.model = provider.model;
    }
    config.defaultProvider = provider.name;
    return `Provider: ${provider.name}; model: ${provider.model}. Saved configuration to ${file}. Set ${provider.apiKeyEnv ?? "the provider API key"} in your environment before running a task.`;
  };
  let finalization: Promise<void> | undefined;
  const finalizeSession = (): Promise<void> => {
    if (!finalization) {
      finalization = (async () => {
        await discardEmptySession(active.info);
        if (active.info.messageCount > 0) {
          console.log(`\nTo resume this session: node src/cli.ts -r ${active.info.id}`);
        }
        terminal?.close();
      })();
    }
    return finalization;
  };
  const exitOnSignal = (code: number) => () => {
    void finalizeSession().finally(() => process.exit(code));
  };
  const onSigint = exitOnSignal(130);
  const onSigterm = exitOnSignal(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const performCompaction = async (instruction?: string): Promise<string> => {
    const beforeTokens = estimateHistoryTokens(history);
    reportEvent({ type: "thinking", role: "compactor", detail: `compacting ~${beforeTokens} tokens` });
    const compacted = await compactConversation({
      history,
      config,
      toolContext: context,
      instruction,
      onEvent: reportEvent,
    });
    await appendSessionCompaction(active.info, compacted.summary, compacted.retainedMessages);
    history = compacted.history;
    return `Context compacted: ~${beforeTokens} -> ~${estimateHistoryTokens(history)} tokens; ${compacted.retainedMessages.length} recent messages retained.`;
  };
  const executeTask = async (task: string): Promise<string> => {
    try {
      context.projectCodeMap = await buildRepositoryMap(options.workspace, config.codeIndex);
    } catch (error) {
      context.projectCodeMap = undefined;
      reportEvent({ type: "thinking", role: "orchestrator", detail: `repository map unavailable: ${(error as Error).message}` });
    }
    const staticContext = [
      context.projectMemory ?? "",
      context.projectCodeMap ?? "",
      ...context.skills.map((skill) => `${skill.name}: ${skill.description} ${skill.whenToUse ?? ""}`),
      task,
    ].join("\n");
    if (needsAutoCompaction(history, config, staticContext)) {
      try {
        await performCompaction("Automatic compaction before the next user task.");
      } catch (error) {
        console.error(`Auto-compaction failed; continuing with the existing context: ${(error as Error).message}`);
      }
    }
    if (active.info.title === NEW_SESSION_TITLE) await renameSession(active.info, task.split(/\r?\n/)[0].slice(0, 80));
    if (mode === "team") {
      const result = await runTeam({
        task,
        config,
        toolContext: context,
        history,
        onEvent: reportEvent,
      });
      const content = `${result.content}\n\nReview:\n${result.review}`;
      history = [...history, { role: "user", content: task }, { role: "assistant", content }];
      await appendSessionTurn(active.info, task, content);
      return content;
    }
    const role = mode === "direct" ? "coder" : "orchestrator";
    const result = await runAgent({ role, task, config, toolContext: context, history, onEvent: reportEvent });
    history = result.history;
    await appendSessionTurn(active.info, task, result.content);
    return result.content;
  };

  const resumeSelectedSession = async (selected: LoadedSession): Promise<string> => {
    if (selected.info.path !== active.info.path) await discardEmptySession(active.info);
    active = selected;
    history = selected.history;
    return `Resumed ${active.info.id}: ${active.info.title} (${history.length} messages loaded)`;
  };
  const handleInteractiveInput = async (answer: string, useTuiPicker = false): Promise<{ output?: string; exit?: boolean }> => {
    const task = answer.trim();
    if (!task) return {};
    const [rawCommand, ...parts] = task.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = parts.join(" ").trim();

    if (["/exit", "/quit", "/q"].includes(command)) return { exit: true };
    if (["/help", "/h", "/?"].includes(command)) return { output: INTERACTIVE_HELP };
    if (command === "/team") {
      mode = "team";
      return { output: "Mode: team (architect -> coder -> reviewer)." };
    }
    if (command === "/direct") {
      mode = "direct";
      return { output: "Mode: direct (coder)." };
    }
    if (command === "/orchestrate") {
      mode = "orchestrate";
      return { output: "Mode: orchestrate." };
    }
    if (command === "/provider") {
      if (!argument) return { output: `Provider: ${currentProvider()}. Use /provider <name> to switch this session.` };
      return { output: selectProvider(parts[0] ?? "") };
    }
    if (["/new", "/clear", "/reset"].includes(command)) {
      await discardEmptySession(active.info);
      active = { info: await createSession(options.workspace), history: [] };
      history = [];
      return { output: `Started session ${active.info.id}` };
    }
    if (["/sessions", "/session", "/resume"].includes(command)) {
      if (!argument && useTuiPicker) return { output: "Choose a session from the session picker." };
      const selected = argument
        ? await loadSession(options.workspace, argument)
        : await pickSession(options.workspace, terminal);
      return selected ? { output: await resumeSelectedSession(selected) } : {};
    }
    if (["/title", "/rename"].includes(command)) {
      if (!argument) return { output: active.info.title };
      await renameSession(active.info, argument);
      return { output: `Title: ${active.info.title}` };
    }
    if (command === "/fork") {
      active = await forkSession(options.workspace, active.info);
      history = active.history;
      return { output: `Forked into ${active.info.id}` };
    }
    if (["/export-md", "/export"].includes(command)) {
      const destination = argument || path.join(options.workspace, `jevio-export-${active.info.id.slice(0, 8)}.md`);
      return { output: `Exported to ${await exportSession(active.info, destination)}` };
    }
    if (command === "/compact") {
      if (argument === "status") {
        const role = config.roles.compactor;
        const provider = role.provider ?? config.defaultProvider;
        return {
          output: [
            `model: ${provider}/${role.model}`,
            `auto: ${config.compaction.auto}`,
            `estimated context: ~${estimateHistoryTokens(history)} tokens / ${config.compaction.contextWindowTokens}`,
            `reserved: ${config.compaction.reservedTokens} tokens`,
            `characters: ${historyCharacters(history)} / fallback ${config.compaction.triggerCharacters}`,
            `keep recent: ${config.compaction.keepRecentMessages} messages`,
          ].join("\n"),
        };
      }
      try {
        return { output: await performCompaction(argument || undefined) };
      } catch (error) {
        return { output: `Compaction failed: ${(error as Error).message}` };
      }
    }
    if (command === "/memory") {
      if (parts[0] === "add") {
        const entry = parts.slice(1).join(" ").trim();
        if (!entry) return { output: "Usage: /memory add <text>" };
        const file = await appendProjectMemory(options.workspace, entry);
        context.projectMemory = await loadProjectMemory(options.workspace);
        return { output: `Memory updated: ${file}` };
      }
      if (parts[0] === "clear") {
        if (!(await confirm("Clear project memory?"))) return { output: "Memory clear cancelled." };
        const file = await clearProjectMemory(options.workspace);
        context.projectMemory = "";
        return { output: `Memory cleared: ${file}` };
      }
      return { output: context.projectMemory?.trim() || "Project memory is empty." };
    }
    return { output: await executeTask(task) };
  };

  try {
    if (options.task) {
      console.log(`\n${await executeTask(options.task)}`);
      return;
    }

    if (process.stdin.isTTY && process.stdout.isTTY) {
      terminal?.close();
      tui = new InteractiveTui({
        workspace: options.workspace,
        submit: (input) => handleInteractiveInput(input, true),
        listSessions: async () => (await listSessions(options.workspace)).map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
        })),
        resumeSession: async (id) => resumeSelectedSession(await loadSession(options.workspace, id)),
        getSession: () => ({
          id: active.info.id,
          title: active.info.title,
          messageCount: active.info.messageCount,
        }),
        getMode: () => mode,
        getProvider: currentProvider,
        listProviders: async () => Object.entries(config.providers).map(([name, provider]) => ({
          name,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
        })),
        selectProvider: async (name) => selectProvider(name),
        addProvider,
      });
      await tui.run();
      return;
    }

    const pipedInput = (await readPipedInput()).trim();
    if (!pipedInput) return;
    const entries = pipedInput.split(/\r?\n/).every((entry) => entry.trim().startsWith("/"))
      ? pipedInput.split(/\r?\n/).filter((entry) => entry.trim())
      : [pipedInput];
    for (const entry of entries) {
      const result = await handleInteractiveInput(entry);
      if (result.output) console.log(result.output);
      if (result.exit) break;
    }
    return;

  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await finalizeSession();
  }
}

main().catch((error) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
});
