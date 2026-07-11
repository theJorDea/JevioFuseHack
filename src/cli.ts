#!/usr/bin/env node
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runAgent, type AgentEvent } from "./agent.ts";
import {
 compactConversation,
 estimateHistoryTokens,
 historyCharacters,
 needsAutoCompaction,
} from "./compaction.ts";
import { addProviderConfig, loadConfig, saveProviderSecret, setAllRolesModelConfig, setDefaultProviderConfig, setRoleProviderConfig } from "./config.ts";
import { formatCritiqueAppendix, runCritique, type CritiqueResult } from "./critique.ts";
import { dreamStatus, runDream } from "./dream.ts";
import { generateIdeas } from "./ideas.ts";
import { formatKairosReport, runKairos, shouldAutoKairos } from "./kairos.ts";
import { CogneeMemory, completedTurnMemory, explicitMemoryDocument } from "./memory.ts";
import {
 appendMemoryProvenance,
 attachMemoryRemoteReceipt,
 clearMemoryProvenance,
 formatMemoryExplanation,
 listMemoryProvenance,
 supersededMemoryIds,
} from "./memory-journal.ts";
import { runCouncilPlan, runCouncilReview, runTeam } from "./orchestrator.ts";
import { createPlanDocument, writePlanDocument, type PlanDocument } from "./plan.ts";
import { cogneeConfigForProject, loadProjectIdentity } from "./project-identity.ts";
import {
 appendProjectMemory,
 appendSessionCouncil,
 appendSessionCompaction,
 appendSessionTurn,
 clearProjectMemory,
 createSession,
 discardEmptySession,
 exportSession,
 forkSession,
 listSessions,
 loadProjectMemory,
 loadLatestCouncilReview,
 loadSession,
 NEW_SESSION_TITLE,
 replaceProjectMemory,
 renameSession,
 saveSessionTodos,
 type LoadedSession,
 type SessionInfo,
} from "./session.ts";
import { discoverSkills } from "./skills.ts";
import { buildRepositoryMap, getCtagsStatus, prewarmSymbolIndex } from "./symbol-index.ts";
import { InteractiveTui } from "./interactive-tui.ts";
import { McpPluginManager } from "./mcp.ts";
import { addTraceEvent, initializeTelemetry, setTraceAttributes, shutdownTelemetry, withTraceSpan } from "./telemetry.ts";
import { formatAskUserNudge, isImplementationRequest, needsUserClarification, recommendExecutionMode } from "./task-intent.ts";
import { defaultModel, discoverLocalProviders, isSupportedNodeVersion, listProviderModels } from "./setup.ts";
import { formatInteractiveHelp, formatSubcommandHelp, resolveSlashCommand } from "./slash-commands.ts";
import type { ChatMessage, ExecutionMode, PlanModeState, RoleName, ToolContext, VerificationRecord } from "./types.ts";

interface CliOptions {
 command: "run" | "init" | "setup" | "doctor" | "skills" | "plugins" | "review" | "fix-review" | "web" | "help";
 task: string;
 workspace: string;
 configPath?: string;
 team: boolean;
 direct: boolean;
 councilPlan: boolean;
 councilReview: boolean;
 yes: boolean;
 /** Session YOLO starts enabled (same as --yes, but can also be toggled via /yolo). */
 yolo: boolean;
 continueSession: boolean;
 sessionRequested: boolean;
 sessionId?: string;
 webPort?: number;
 webHost?: string;
 webNoOpen?: boolean;
}

const HELP = `Jevio - local-first coding agent

Usage:
 jevio [options] [task] Запустить задачу; без задачи открыть интерактивный режим
 jevio web Открыть веб-интерфейс (для работы без терминала)
 jevio init Создать jevio.config.json и стартовый skill
 jevio setup Настроить локального провайдера в интерактивном режиме
 jevio doctor Проверить конфигурацию и endpoints моделей
 jevio skills Показать найденные skills проекта
 jevio plugins Показать MCP-плагины и доступные инструменты
 jevio fix-review Исправить подтвержденные findings последнего Council Review

Options:
 --continue, -c Продолжить последнюю сессию в проекте
 --session, -S [id] Выбрать или продолжить конкретную сессию
 --resume, -r [id] Alias for --session
 --team Конвейер architect -> coder -> reviewer
 --council-plan 3 architect -> judge -> coder -> reviewer
 --council-review 3 reviewer по рискам -> judge
 --direct Работать напрямую через coder без оркестрации
 --yes, -y Автоматически разрешать записи, shell и MCP-плагины
 --yolo Alias для --yes (режим YOLO)
 --workspace, -w <path> Папка проекта (по умолчанию текущая)
 --config, -C <path> Явный файл конфигурации
 --port, -p <n> Порт для jevio web (по умолчанию 8787)
 --host <addr> Хост для jevio web (по умолчанию 127.0.0.1)
 --no-open Не открывать браузер для jevio web
 --help, -h Показать эту справку
`;

function parseArgs(argv: string[]): CliOptions {
 const options: CliOptions = {
 command: "run",
 task: "",
 workspace: process.cwd(),
 team: false,
 direct: false,
 councilPlan: false,
 councilReview: false,
 yes: false,
 yolo: false,
 continueSession: false,
 sessionRequested: false,
 };
 const taskParts: string[] = [];
 for (let index = 0; index < argv.length; index += 1) {
 const argument = argv[index];
 if (index === 0 && ["init", "setup", "doctor", "skills", "plugins", "review", "fix-review", "web"].includes(argument)) {
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
 } else if (argument === "--council-plan") {
 options.councilPlan = true;
 } else if (argument === "--council-review" || argument === "--council") {
 options.councilReview = true;
 } else if (argument === "--direct") {
 options.direct = true;
 } else if (argument === "--yes" || argument === "-y" || argument === "--yolo") {
 options.yes = true;
 options.yolo = true;
 } else if (argument === "--workspace" || argument === "-w") {
 const value = argv[++index];
 if (!value) throw new Error(`${argument} requires a path.`);
 options.workspace = path.resolve(value);
 } else if (argument === "--config" || argument === "-C") {
 const value = argv[++index];
 if (!value) throw new Error(`${argument} requires a path.`);
 options.configPath = value;
 } else if (argument === "--port" || argument === "-p") {
 const value = argv[++index];
 if (!value) throw new Error(`${argument} requires a port.`);
 options.webPort = Number(value);
 } else if (argument === "--host") {
 const value = argv[++index];
 if (!value) throw new Error(`${argument} requires a host.`);
 options.webHost = value;
 } else if (argument === "--no-open") {
 options.webNoOpen = true;
 } else if (index > 0 || options.command === "run") {
 taskParts.push(argument);
 }
 }
 if (options.continueSession && options.sessionRequested) {
 throw new Error("--continue and --session cannot be used together.");
 }
 options.task = taskParts.join(" ").trim();
 if (options.command === "review") {
 options.councilReview = true;
 if (!options.task) options.task = "Review current workspace changes.";
 }
 if (options.command === "fix-review") options.continueSession = true;
 if ([options.team, options.direct, options.councilPlan, options.councilReview].filter(Boolean).length > 1) {
 throw new Error("Choose only one execution mode.");
 }
 return options;
}

function eventReporter(event: AgentEvent): void {
 if (event.type === "tool") process.stderr.write(` [${event.role}] ${event.detail}\n`);
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

const execFileAsync = promisify(execFile);

async function gitVersion(): Promise<string | null> {
 try {
 const { stdout } = await execFileAsync("git", ["--version"], { windowsHide: true });
 return String(stdout).trim();
 } catch {
 return null;
 }
}

async function chooseSetupItem(terminal: Interface, title: string, items: string[], defaultIndex = 0): Promise<number> {
 process.stdout.write(`\n${title}\n`);
 items.forEach((item, index) => process.stdout.write(` ${index + 1}. ${item}${index === defaultIndex ? " (по умолчанию)" : ""}\n`));
 while (true) {
 const answer = (await terminal.question(`Выбор [${defaultIndex + 1}]: `)).trim();
 if (!answer) return defaultIndex;
 const selected = Number.parseInt(answer, 10) - 1;
 if (Number.isInteger(selected) && selected >= 0 && selected < items.length) return selected;
 process.stdout.write("Введите номер из списка.\n");
 }
}

async function setup(options: CliOptions): Promise<string | undefined> {
 process.stdout.write("\nFuse setup\n\n");
 const nodeVersion = process.version;
 process.stdout.write(`${isSupportedNodeVersion(nodeVersion) ? "OK" : "WARN"} Node.js ${nodeVersion}${isSupportedNodeVersion(nodeVersion) ? "" : "; рекомендуется 22.19 или новее"}\n`);
 const git = await gitVersion();
 process.stdout.write(`${git ? "OK" : "WARN"} ${git ?? "Git не найден; git diff и часть ревью будут недоступны"}\n`);

 const configPath = options.configPath ? path.resolve(options.configPath) : path.join(options.workspace, "jevio.config.json");
 if (await exists(configPath)) {
 process.stdout.write(`\nКонфигурация уже существует: ${configPath}\nЗапускаю doctor без перезаписи.\n`);
 await doctor(options);
 return undefined;
 }
 if (!process.stdin.isTTY) throw new Error("jevio setup requires an interactive terminal.");

 const terminal = createInterface({ input: process.stdin, output: process.stdout });
 try {
 process.stdout.write("\nИщу Ollama и LM Studio...\n");
 const candidates = await discoverLocalProviders();
 const providerItems = [
 ...candidates.map((candidate) => `${candidate.label} (${candidate.models.length} моделей)`),
 "Другой OpenAI-compatible endpoint",
 ];
 const providerIndex = await chooseSetupItem(terminal, "Выберите провайдера", providerItems);
 const selected = candidates[providerIndex];
 const provider = selected ?? {
 name: "custom",
 label: "Custom",
 baseUrl: (await terminal.question("Base URL (например, http://localhost:8080/v1): ")).trim(),
 models: [],
 };
 if (!provider.baseUrl) throw new Error("Base URL is required.");

 let model: string;
 if (provider.models.length) {
 const fallback = defaultModel(provider.models) ?? provider.models[0];
 const modelIndex = await chooseSetupItem(terminal, "Доступные модели", provider.models, Math.max(0, provider.models.indexOf(fallback)));
 model = provider.models[modelIndex];
 } else {
 model = (await terminal.question("ID модели: ")).trim();
 if (!model) throw new Error("Model ID is required.");
 }

 const file = await addProviderConfig(options.workspace, options.configPath, {
 name: provider.name,
 baseUrl: provider.baseUrl,
 model,
 ...(provider.name === "lmstudio" ? { toolMode: "text" as const } : {}),
 });
 process.stdout.write(`\nГотово: ${file}\nПровайдер: ${provider.label}; модель: ${model}\n\nПроверка конфигурации:\n`);
 await doctor(options);
 const runDemo = (await terminal.question("\nЗапустить безопасную демо-задачу для проверки модели? [Y/n] ")).trim();
 return /^(?:|y|yes|д|да)$/i.test(runDemo)
 ? "Осмотри этот репозиторий, кратко опиши его структуру, доступные команды проверки и одну безопасную следующую задачу. Не изменяй файлы."
 : undefined;
 } finally {
 terminal.close();
 }
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
 shellMode: config.permissions.shellMode,
 maxToolOutputCharacters: config.agent.maxToolOutputCharacters,
 confirm,
 },
 };
}

async function doctor(options: CliOptions): Promise<void> {
 const config = await loadConfig(options.workspace, options.configPath);
 const projectIdentity = await loadProjectIdentity(options.workspace);
 let failures = 0;
 const memory = new CogneeMemory(cogneeConfigForProject(config.memory.cognee, projectIdentity), options.workspace);
 console.log(`OK project identity: ${projectIdentity.id}; dataset ${memory.dataset}`);
 if (memory.enabled) {
 const status = await memory.status();
 if (status.available) console.log(`OK Cognee memory: ${status.detail}; dataset ${status.dataset}; pipeline ${status.pipelineStatus ?? "unknown"}`);
 else {
 console.log(`FAIL Cognee memory: ${status.detail}`);
 failures += 1;
 }
 } else {
 console.log("INFO Cognee memory: disabled; using Markdown memory only");
 }
 if (config.telemetry.enabled) {
 const target = config.telemetry.exporter === "otlp"
 ? (config.telemetry.endpointEnv ? process.env[config.telemetry.endpointEnv] ?? `missing ${config.telemetry.endpointEnv}` : config.telemetry.endpoint)
 : "stdout";
 console.log(`OK telemetry: ${config.telemetry.exporter}; target ${target}; sample ${config.telemetry.sampleRatio}`);
 } else {
 console.log("INFO telemetry: disabled");
 }
 if (config.codeIndex.enabled && config.codeIndex.backend !== "builtin") {
 const ctags = await getCtagsStatus();
 if (ctags.available) console.log(`OK code index: ${ctags.detail}`);
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
 console.log(`OK ${name}: ${provider.baseUrl}`);
 } catch (error) {
 console.log(`FAIL ${name}: ${(error as Error).message}`);
 failures += 1;
 }
 }
 if (failures) process.exitCode = 1;
}

function printSessions(sessions: SessionInfo[]): void {
 if (!sessions.length) {
 console.log("В этом проекте нет сохраненных сессий.");
 return;
 }
 sessions.forEach((session, index) => {
 const updated = session.updatedAt.replace("T", " ").slice(0, 16);
 console.log(`${String(index + 1).padStart(2)}. ${session.id} ${updated} ${session.title}`);
 });
}

async function pickSession(workspace: string, terminal: Interface): Promise<LoadedSession | null> {
 const sessions = await listSessions(workspace);
 printSessions(sessions);
 if (!sessions.length || !process.stdin.isTTY) return null;
 const answer = (await terminal.question("Номер или ID сессии (пустая строка — отмена): ")).trim();
 if (!answer) return null;
 const numbered = Number.parseInt(answer, 10);
 const requested = Number.isInteger(numbered) && String(numbered) === answer
 ? sessions[numbered - 1]?.id
 : answer;
 if (!requested) throw new Error("Некорректный выбор сессии.");
 return loadSession(workspace, requested);
}

async function initialSession(options: CliOptions, terminal?: Interface): Promise<LoadedSession> {
 if (options.continueSession) {
 const sessions = await listSessions(options.workspace);
 return sessions.length ? loadSession(options.workspace, "latest") : { info: await createSession(options.workspace), history: [], todos: [] };
 }
 if (options.sessionRequested) {
 if (options.sessionId) return loadSession(options.workspace, options.sessionId);
 const picked = terminal ? await pickSession(options.workspace, terminal) : null;
 if (picked) return picked;
 }
 return { info: await createSession(options.workspace), history: [], todos: [] };
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
 if (options.command === "setup") {
 const demoTask = await setup(options);
 if (!demoTask) return;
 options.command = "run";
 options.task = demoTask;
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
 if (options.command === "plugins") {
 const config = await loadConfig(options.workspace, options.configPath);
 const plugins = await McpPluginManager.create(options.workspace, config);
 try {
 console.log(plugins.statusText());
 } finally {
 await plugins.close();
 }
 return;
 }
 if (options.command === "web") {
 const { startWebServer } = await import("./web-server.ts");
 const { url } = await startWebServer({
 workspace: options.workspace,
 host: options.webHost || "127.0.0.1",
 port: options.webPort ?? 8787,
 yolo: options.yolo || options.yes,
 openBrowser: !options.webNoOpen,
 });
 process.stdout.write(`\nFuse web: ${url}\n`);
 process.stdout.write(`Workspace: ${options.workspace}\n`);
 process.stdout.write("Открой ссылку в браузере. Ctrl+C — стоп.\n\n");
 if (!options.webNoOpen) {
 try {
 if (process.platform === "win32") {
 execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
 } else if (process.platform === "darwin") {
 execFile("open", [url]);
 } else {
 execFile("xdg-open", [url]);
 }
 } catch {
 // browser open is best-effort
 }
 }
 await new Promise(() => {
 // keep process alive until Ctrl+C
 });
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
 initializeTelemetry(config.telemetry);
 const projectIdentity = await loadProjectIdentity(options.workspace);
 const mcpPlugins = await McpPluginManager.create(options.workspace, config);
 context.plugins = mcpPlugins;
 let yolo = options.yes || options.yolo;
 const baseShellMode = config.permissions.shellMode;
 const applyYoloPermissions = (): void => {
 context.autoApproveWrites = yolo || config.permissions.autoApproveWorkspaceWrites;
 context.autoApproveShell = yolo || config.permissions.autoApproveShell;
 context.autoApprovePlugins = yolo || config.permissions.autoApprovePlugins;
 context.shellMode = yolo ? "full" : baseShellMode;
 };
 applyYoloPermissions();
 const cogneeMemory = new CogneeMemory(cogneeConfigForProject(config.memory.cognee, projectIdentity), options.workspace);
 context.askUser = async (questionOrRequest, choices) => {
 const request = typeof questionOrRequest === "string"
 ? {
 questions: [{
 id: "q1",
 question: questionOrRequest,
 options: choices ?? [],
 multiSelect: false,
 allowOther: true,
 }],
 }
 : questionOrRequest;
 if (tui) {
      const answers = [];
      const transcriptAnswers = [];
      for (const item of request.questions) {
        const answer = await tui.askUser(item.question, item.options ?? [], item.multiSelect ?? false, item.allowOther ?? true, false);
        answers.push(`${item.id ?? item.question}: ${answer}`);
        if (answer !== "[cancelled]") transcriptAnswers.push(`${item.id ?? "Ответ"}: ${answer}`);
        if (answer === "[cancelled]") break;
      }
      if (transcriptAnswers.length) tui.appendUserAnswer(transcriptAnswers.join("\n"));
      return answers.join("\n") || "[cancelled]";
    }
 if (!terminal) return "[unavailable: non-interactive run]";
 // Non-TUI fallback: sequential prompts.
 const answers: string[] = [];
 if (request.header) process.stdout.write(`\n${request.header}\n`);
 for (const item of request.questions) {
 const opts = item.options ?? [];
 process.stdout.write(`\n${item.question}\n`);
 if (opts.length) {
 opts.forEach((choice, index) => {
 process.stdout.write(` ${index + 1}. ${choice.label}${choice.description ? ` - ${choice.description}` : ""}\n`);
 });
 if (item.multiSelect) process.stdout.write(" (можно несколько через запятую: 1,3)\n");
 }
 const answer = (await terminal.question(opts.length ? "Выберите номер или введите ответ: " : "> ")).trim();
 if (!answer) {
 answers.push(`${item.id ?? item.question}: [cancelled]`);
 continue;
 }
 if (opts.length && item.multiSelect) {
 const picks = answer.split(/[,;\s]+/).flatMap((token) => {
 const n = Number.parseInt(token, 10);
 if (Number.isInteger(n) && opts[n - 1]) return [opts[n - 1].label];
 return token ? [token] : [];
 });
 answers.push(`${item.id ?? item.question}: ${picks.join(", ") || answer}`);
 } else {
 const n = Number.parseInt(answer, 10);
 const picked = Number.isInteger(n) && String(n) === answer && opts[n - 1]
 ? opts[n - 1].label
 : answer;
 answers.push(`${item.id ?? item.question}: ${picked}`);
 }
 }
 return answers.join("\n") || "[cancelled]";
 };
 void prewarmSymbolIndex(options.workspace, config.codeIndex).catch((error) => {
 process.stderr.write(` [symbol-index] background prewarm failed: ${(error as Error).message}\n`);
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
 let turnVerifications: VerificationRecord[] = [];
 context.recordVerification = (record) => {
 turnVerifications.push(record);
 addTraceEvent("jevio.verification", {
 "jevio.verification.command": record.command.slice(0, 200),
 "jevio.verification.exit_code": String(record.exitCode),
 });
 };
 let successfulTurns = 0;
 /** Last lightweight critique (for /critique fix). */
 let lastCritique: CritiqueResult | undefined;
 const rememberCognee = async (content: string, filename: string, sessionAware = true, recordId?: string): Promise<string | undefined> => {
 if (!cogneeMemory.enabled) return undefined;
 try {
 const receipt = await cogneeMemory.remember(content, sessionAware ? active.info.id : undefined, filename);
 if (recordId) await attachMemoryRemoteReceipt(options.workspace, recordId, receipt);
 return undefined;
 } catch (error) {
 const warning = `Cognee write skipped: ${(error as Error).message}`;
 reportEvent({ type: "thinking", role: "orchestrator", detail: warning });
 return warning;
 }
 };
 const recordMemoryProvenance = async (
 kind: "completed_task" | "explicit_memory",
 request: string,
 result: string,
 verifications: VerificationRecord[],
 supersedes: string[] = [],
 ) => {
 try {
 return await appendMemoryProvenance(options.workspace, {
 kind,
 projectId: projectIdentity.id,
 sessionId: active.info.id,
 request,
 result,
 verifications,
 supersedes,
 });
 } catch (error) {
 reportEvent({ type: "thinking", role: "orchestrator", detail: `Memory provenance skipped: ${(error as Error).message}` });
 return undefined;
 }
 };
 const recordSuccessfulTurn = async (task: string, content: string): Promise<void> => {
 await appendSessionTurn(active.info, task, content);
 const provenance = await recordMemoryProvenance("completed_task", task, content, turnVerifications);
 if (config.memory.cognee.rememberCompletedTurns) {
 await rememberCognee(completedTurnMemory(task, content, provenance), `turn-${active.info.messageCount}.md`, true, provenance?.id);
 }
 successfulTurns += 1;
 // Lightweight auto-KAIROS: after every 2nd successful interactive turn, surface watch/action signals.
 if (tui && successfulTurns % 2 === 0) {
 void runKairos({ workspace: options.workspace, config, toolContext: context, synthesize: false })
 .then((observation) => {
 if (!shouldAutoKairos(observation, { minSeverity: "watch" })) return;
 tui?.appendSystem(formatKairosReport(observation));
 })
 .catch(() => {
 // Proactive scan must never break the main loop.
 });
 }
 };
 let workspaceMutationCount = 0;
 context.todos = active.todos;
 context.updateTodos = async (items) => {
 active.todos = items;
 context.todos = items;
 tui?.setTodos(items);
 await saveSessionTodos(active.info, items);
 reportEvent({
 type: "progress",
 role: "orchestrator",
 detail: `todo ${items.filter((item) => item.status === "completed").length}/${items.length}`,
 });
 };
 context.onWorkspaceChange = () => {
 workspaceMutationCount += 1;
 };
 let mode: ExecutionMode = options.councilPlan
 ? "council-plan"
 : options.councilReview
 ? "council-review"
 : options.team
 ? "team"
 : options.direct
 ? "direct"
 : "orchestrate";
 const planMode: PlanModeState = { active: false };
 let planDocumentForTools: PlanDocument | undefined;
 let modeSuggestionUsed = false;
 /** When true (default), host auto-picks team/council/plan for this task while sticky mode is orchestrate. */
 let autoRoute = true;
 let pendingModeRestart: { mode: ExecutionMode; reason: string } | undefined;
 context.planMode = planMode;
 context.enterPlanMode = async (goal) => {
 planMode.active = true;
 planMode.goal = goal;
 planMode.enteredAt = new Date().toISOString();
 planMode.approvedPlan = undefined;
 reportEvent({ type: "progress", role: "orchestrator", detail: goal ? `Plan Mode: ${goal}` : "Plan Mode active" });
 return `Plan Mode active${goal ? ` (goal: ${goal})` : ""}. Write tools and coder delegation are blocked. Explore, then call submit_plan or exit_plan_mode.`;
 };
 context.exitPlanMode = async (reason) => {
 planMode.active = false;
 planMode.goal = undefined;
 planMode.enteredAt = undefined;
 // Keep approvedPlan if already set so implement can follow it.
 reportEvent({ type: "progress", role: "orchestrator", detail: reason ? `Left Plan Mode: ${reason}` : "Left Plan Mode" });
 return `Plan Mode exited${reason ? `: ${reason}` : ""}. Writes are allowed again.`;
 };
 context.submitPlan = async (plan) => {
 planDocumentForTools ??= await createPlanDocument(options.workspace, active.info.id);
 await writePlanDocument(planDocumentForTools, plan, "pending");
 let decision: { decision: "approve" | "reject" | "revise"; feedback?: string };
 if (yolo || options.yes) {
 decision = { decision: "approve" };
 } else if (tui) {
 decision = await tui.reviewPlan(plan, planDocumentForTools.path);
 } else if (terminal) {
 process.stdout.write(`\nПлан реализации\n\n${plan}\n\nФайл: ${planDocumentForTools.path}\n`);
 const answer = (await terminal.question("Одобрить план? [y] да / [n] нет / [o] предложить изменения: ")).trim().toLowerCase();
 if (/^(y|yes|д|да)$/.test(answer)) decision = { decision: "approve" };
 else if (/^(o|other|другое)$/.test(answer)) {
 const feedback = (await terminal.question("Что изменить в плане? ")).trim();
 decision = feedback ? { decision: "revise", feedback } : { decision: "reject" };
 } else decision = { decision: "reject" };
 } else {
 throw new Error("План требует интерактивного согласования. Для CI используйте --yes или --yolo.");
 }
 if (decision.feedback) planDocumentForTools.feedback.push(decision.feedback);
 await writePlanDocument(
 planDocumentForTools,
 plan,
 decision.decision === "approve" ? "approved" : decision.decision === "reject" ? "rejected" : "pending",
 );
 if (decision.decision === "approve") {
 planMode.approvedPlan = plan;
 planMode.active = false;
 return `Plan approved. Plan Mode ended. Implement this plan now:\n\n${plan}`;
 }
 if (decision.decision === "revise") {
 planMode.active = true;
 return `User requested plan revisions. Stay in Plan Mode and revise.\n\nFEEDBACK:\n${decision.feedback ?? ""}`;
 }
 planMode.active = false;
 planMode.approvedPlan = undefined;
 return "Plan rejected by user. Plan Mode ended. Do not edit files unless the user gives a new request.";
 };
 context.suggestMode = async (suggestedMode, reason, options) => {
 if (modeSuggestionUsed || suggestedMode === mode) return false;
 modeSuggestionUsed = true;
 const applyNow = options?.applyNow !== false;
 let accepted = false;
 // YOLO/--yes auto-accept. Host auto-route only pre-picks high-confidence modes at task start;
 // mid-task suggest_mode always asks unless non-interactive.
 if (yolo || options.yes) {
 accepted = true;
 reportEvent({
 type: "progress",
 role: "orchestrator",
 detail: `auto mode → ${suggestedMode}: ${reason}`,
 });
 } else if (tui) {
 const answer = await tui.askUser(
 `Fuse предлагает режим ${suggestedMode}.\n\n${reason}\n\n${applyNow ? "Применить к текущей задаче?" : "Переключить для следующих задач?"}`,
 [
 { label: "Переключить", description: `Использовать ${suggestedMode}` },
 { label: "Оставить", description: `Сохранить ${mode}` },
 ],
 );
 accepted = answer === "Переключить";
 } else if (terminal) {
 const answer = await terminal.question(
 `Fuse предлагает режим ${suggestedMode}: ${reason}\nПереключить${applyNow ? " сейчас" : " для следующих задач"}? [Y/n] `,
 );
 accepted = !answer.trim() || /^(y|yes|д|да)$/i.test(answer.trim());
 } else {
 accepted = true;
 }
 if (accepted) {
 mode = suggestedMode;
 if (suggestedMode === "plan") {
 planMode.active = true;
 planMode.enteredAt = new Date().toISOString();
 } else {
 planMode.active = false;
 }
 tui?.refreshHeader();
 if (applyNow) pendingModeRestart = { mode: suggestedMode, reason };
 }
 return accepted;
 };
 const currentProvider = (): string => {
 const providers = new Set(Object.values(config.roles).map((role) => role.provider ?? config.defaultProvider));
 return providers.size === 1 ? [...providers][0] : "mixed";
 };
 const selectProvider = async (name: string, applyDefaultModel = false): Promise<string> => {
 if (!config.providers[name]) throw new Error(`Unknown provider '${name}'. Add it to jevio.config.json first.`);
 const file = await setDefaultProviderConfig(options.workspace, options.configPath, name, { applyDefaultModel });
 config.defaultProvider = name;
 const defaultModelName = config.providers[name].defaultModel;
 for (const role of Object.values(config.roles)) {
 role.provider = name;
 if (applyDefaultModel && defaultModelName) {
 role.model = defaultModelName;
 if (/\bkimi\b/i.test(defaultModelName)) role.temperature = 1;
 }
 }
 const modelNote = applyDefaultModel && defaultModelName
 ? ` Модель ролей: ${defaultModelName}.`
 : " Модели ролей не изменены — /models чтобы выбрать.";
 return `Провайдер: ${name}.${modelNote} Сохранено в ${file}.`;
 };
 const currentModel = (): string => {
 const models = new Set(Object.values(config.roles).map((role) => role.model));
 return models.size === 1 ? [...models][0] : "mixed";
 };
 const resolveProviderApiKey = (providerName: string): string | undefined => {
 const provider = config.providers[providerName];
 if (!provider) return undefined;
 return provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
 };
 const listModelsForProvider = async (providerName?: string): Promise<{
 provider: string;
 models: string[];
 current: string;
 detail?: string;
 }> => {
 const name = providerName && config.providers[providerName]
 ? providerName
 : currentProvider() === "mixed"
 ? config.defaultProvider
 : currentProvider();
 const provider = config.providers[name];
 if (!provider) throw new Error(`Unknown provider '${name}'.`);
 try {
 const models = await listProviderModels(provider.baseUrl, {
 apiKey: resolveProviderApiKey(name),
 timeoutMs: 8_000,
 });
 return {
 provider: name,
 models,
 current: currentModel(),
 detail: models.length ? undefined : "Endpoint ответил, но список моделей пуст.",
 };
 } catch (error) {
 // Fallback: still useful when /models is unavailable on the gateway.
 const known = [
 ...new Set([
 provider.defaultModel,
 ...Object.values(config.roles)
 .filter((role) => (role.provider ?? config.defaultProvider) === name)
 .map((role) => role.model),
 ].filter((value): value is string => Boolean(value?.trim()))),
 ];
 return {
 provider: name,
 models: known,
 current: currentModel(),
 detail: `Не удалось получить /models (${(error as Error).message}). Показаны известные модели из конфига; можно задать id вручную: /models <id>.`,
 };
 }
 };
 const selectModel = async (model: string, providerName?: string): Promise<string> => {
 const normalized = model.trim();
 if (!normalized) throw new Error("Укажите id модели: /models <id>");
 const provider = providerName && config.providers[providerName]
 ? providerName
 : currentProvider() === "mixed"
 ? config.defaultProvider
 : currentProvider();
 if (!config.providers[provider]) throw new Error(`Unknown provider '${provider}'.`);
 const file = await setAllRolesModelConfig(options.workspace, options.configPath, normalized, provider);
 for (const role of Object.values(config.roles)) {
 role.provider = provider;
 role.model = normalized;
 if (/\bkimi\b/i.test(normalized)) role.temperature = 1;
 }
 config.defaultProvider = provider;
 if (config.providers[provider]) config.providers[provider].defaultModel = normalized;
 return `Модель: ${normalized} · провайдер: ${provider}. Применено ко всем ролям. Сохранено в ${file}.`;
 };
 const modelsStatusText = (): string => {
 const lines = [
 `Провайдер: ${currentProvider()}`,
 `Модель: ${currentModel()}`,
 "",
 "Роли:",
 ...Object.entries(config.roles).map(([role, settings]) =>
 ` ${role}: ${(settings.provider ?? config.defaultProvider)} / ${settings.model}`),
 ];
 return lines.join("\n");
 };
 const addProvider = async (
 provider: { name: string; baseUrl: string; apiKey?: string; model: string; transport?: "chat_completions" | "responses"; toolMode?: "auto" | "native" | "text" },
 addOptions: { applyToAllRoles?: boolean } = {},
 ): Promise<string> => {
 const applyToAllRoles = addOptions.applyToAllRoles !== false;
 const file = await addProviderConfig(options.workspace, options.configPath, provider, { applyToAllRoles });
 config.providers[provider.name] = {
 baseUrl: provider.baseUrl.replace(/\/$/, ""),
 defaultModel: provider.model,
 ...(provider.transport ? { transport: provider.transport } : {}),
 ...(provider.toolMode ? { toolMode: provider.toolMode } : {}),
 ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
 };
 if (applyToAllRoles) {
 for (const role of Object.values(config.roles)) {
 role.provider = provider.name;
 role.model = provider.model;
 if (/\bkimi\b/i.test(provider.model)) role.temperature = 1;
 }
 config.defaultProvider = provider.name;
 }
 const secretFile = provider.apiKey ? await saveProviderSecret(options.workspace, provider.name, provider.apiKey) : undefined;
 const scope = applyToAllRoles ? "применён ко всем ролям" : "добавлен (роли не тронуты)";
 return `Провайдер: ${provider.name}; модель: ${provider.model} — ${scope}. Конфигурация сохранена в ${file}.${secretFile ? ` API-ключ: ${secretFile}.` : ""}`;
 };
 const configureRole = async (role: string, providerName: string, model: string): Promise<string> => {
 if (!(role in config.roles)) throw new Error(`Unknown role '${role}'.`);
 if (!config.providers[providerName]) throw new Error(`Unknown provider '${providerName}'.`);
 const typedRole = role as RoleName;
 const file = await setRoleProviderConfig(options.workspace, options.configPath, typedRole, providerName, model);
 config.roles[typedRole] = { ...config.roles[typedRole], provider: providerName, model };
 if (/\bkimi\b/i.test(model)) config.roles[typedRole].temperature = 1;
 return `${typedRole}: ${providerName} / ${model}. Конфигурация сохранена в ${file}.`;
 };
 const setupReport = async (): Promise<string> => {
 const [git, localProviders, ctags] = await Promise.all([
 gitVersion(),
 discoverLocalProviders(),
 config.codeIndex.enabled && config.codeIndex.backend !== "builtin" ? getCtagsStatus() : Promise.resolve(undefined),
 ]);
 const lines = [
 "# Fuse setup",
 `${isSupportedNodeVersion(process.version) ? "[x]" : "[!]"} Node.js ${process.version}`,
 `${git ? "[x]" : "[!]"} ${git ?? "Git не найден"}`,
 ...(localProviders.length
 ? localProviders.flatMap((provider) => {
 const codeModel = provider.models.find((model) => /(?:coder|code|devstral|deepseek)/i.test(model));
 return [
 `[x] ${provider.label}: ${provider.models.length} моделей`,
 ` ${provider.models.slice(0, 6).join(", ") || "модели не найдены"}${provider.models.length > 6 ? ", ..." : ""}`,
 `${codeModel ? "[x]" : "[!]"} ${provider.label}: ${codeModel ? `найдена code-модель ${codeModel}` : "code-модель не найдена"}`,
 ];
 })
 : ["[!] Ollama и LM Studio на стандартных портах не найдены"]),
 ...(ctags ? [
 `${ctags.available ? "[x]" : "[!]"} Symbol index: ${ctags.detail}`,
 ...(!ctags.available && process.platform === "win32" ? [" Установка: winget install -e --id UniversalCtags.Ctags"] : []),
 ] : []),
 `[x] Конфигурация: ${options.configPath ?? path.join(options.workspace, "jevio.config.json")}`,
 `[x] Настроенные провайдеры: ${Object.keys(config.providers).join(", ")}`,
 `\nMCP-плагины:\n${mcpPlugins.statusText()}`,
 "\nВыберите провайдер или добавьте новый в следующем окне.",
 ];
 return lines.join("\n");
 };
 let finalization: Promise<void> | undefined;
 const finalizeSession = (): Promise<void> => {
 if (!finalization) {
 finalization = (async () => {
 await discardEmptySession(active.info);
 if (active.info.messageCount > 0) {
 console.log(`\nЧтобы продолжить сессию: node src/cli.ts -r ${active.info.id}`);
 }
 terminal?.close();
 await mcpPlugins.close();
 await shutdownTelemetry();
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
 if (config.memory.cognee.rememberCompactions) {
 await rememberCognee(`# Jevio context checkpoint\n\n${compacted.summary}`, `compaction-${Date.now()}.md`);
 }
 history = compacted.history;
 return `Context compacted: ~${beforeTokens} -> ~${estimateHistoryTokens(history)} tokens; ${compacted.retainedMessages.length} recent messages retained.`;
 };
 const executeTaskCore = async (task: string): Promise<string> => {
 turnVerifications = [];
 modeSuggestionUsed = false;
 pendingModeRestart = undefined;
 planDocumentForTools = undefined;

 // Fresh user task: drop previous approved plan so it does not bias the next prompt.
 if (!planMode.active) {
 planMode.approvedPlan = undefined;
 planMode.goal = undefined;
 planMode.enteredAt = undefined;
 }

 // Host auto-routing: only high-confidence recommendations apply automatically.
 let effectiveMode: ExecutionMode = mode;
 if (autoRoute && mode === "orchestrate") {
 const recommendation = recommendExecutionMode(task, history);
 if (recommendation.auto && recommendation.confidence === "high" && recommendation.mode !== "orchestrate") {
 effectiveMode = recommendation.mode;
 reportEvent({
 type: "progress",
 role: "orchestrator",
 detail: `auto-route → ${recommendation.mode} (${recommendation.confidence}): ${recommendation.reason}`,
 });
 tui?.appendSystem?.(
 `Авто-режим: **${recommendation.mode}** — ${recommendation.reason}\n_Отключить: /auto-mode off · вручную: /${recommendation.mode}_`,
 );
 } else if (recommendation.mode !== "orchestrate" && recommendation.confidence !== "low") {
 reportEvent({
 type: "progress",
 role: "orchestrator",
 detail: `mode hint → ${recommendation.mode} (${recommendation.confidence}): ${recommendation.reason}`,
 });
 tui?.appendSystem?.(
 `Подсказка режима: **${recommendation.mode}** — ${recommendation.reason}\n_Применить: \`/${recommendation.mode}\` · auto только high-confidence_`,
 );
 }
 }

 // Persistent /plan mode keeps Plan Mode on for every task until the user leaves it.
 if (effectiveMode === "plan" || mode === "plan") {
 planMode.active = true;
 planMode.goal = task.split(/\r?\n/)[0].slice(0, 120);
 planMode.enteredAt = planMode.enteredAt ?? new Date().toISOString();
 planMode.approvedPlan = undefined;
 effectiveMode = "plan";
 }
 setTraceAttributes({ "jevio.execution.mode": effectiveMode });
 context.retrievedMemory = undefined;
 if (cogneeMemory.enabled) {
 try {
 const records = await listMemoryProvenance(options.workspace, 500);
 context.retrievedMemory = await cogneeMemory.recall(task, active.info.id, supersededMemoryIds(records));
 if (context.retrievedMemory) reportEvent({ type: "thinking", role: "orchestrator", detail: "recalled relevant Cognee memory" });
 } catch (error) {
 reportEvent({ type: "thinking", role: "orchestrator", detail: `Cognee recall skipped: ${(error as Error).message}` });
 }
 }
 let planDocument: PlanDocument | undefined;
 const approvePlan = async (plan: string): Promise<{ decision: "approve" | "reject" | "revise"; feedback?: string }> => {
 planDocument ??= await createPlanDocument(options.workspace, active.info.id);
 await writePlanDocument(planDocument, plan, "pending");
 if (yolo || options.yes) {
 await writePlanDocument(planDocument, plan, "approved");
 return { decision: "approve" };
 }
 let decision: { decision: "approve" | "reject" | "revise"; feedback?: string };
 if (tui) {
 decision = await tui.reviewPlan(plan, planDocument.path);
 } else if (terminal) {
 process.stdout.write(`\nПлан реализации\n\n${plan}\n\nФайл: ${planDocument.path}\n`);
 const answer = (await terminal.question("Одобрить план? [y] да / [n] нет / [o] предложить изменения: ")).trim().toLowerCase();
 if (/^(y|yes|д|да)$/.test(answer)) decision = { decision: "approve" };
 else if (/^(o|other|другое)$/.test(answer)) {
 const feedback = (await terminal.question("Что изменить в плане? ")).trim();
 decision = feedback ? { decision: "revise", feedback } : { decision: "reject" };
 } else decision = { decision: "reject" };
 } else {
 throw new Error("План требует интерактивного согласования. Для CI используйте --yes или --yolo.");
 }
 if (decision.feedback) planDocument.feedback.push(decision.feedback);
 await writePlanDocument(planDocument, plan, decision.decision === "approve" ? "approved" : decision.decision === "reject" ? "rejected" : "pending");
 return decision;
 };
 try {
 context.projectCodeMap = await buildRepositoryMap(options.workspace, config.codeIndex);
 } catch (error) {
 context.projectCodeMap = undefined;
 reportEvent({ type: "thinking", role: "orchestrator", detail: `repository map unavailable: ${(error as Error).message}` });
 }
 const staticContext = [
 context.projectMemory ?? "",
 context.retrievedMemory ?? "",
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
 const requiresWorkspaceChange = isImplementationRequest(task, history);
 // Force ask_user on vague product/UI tasks when interactive.
 let agentTask = task;
 if (context.askUser) {
 const clarification = needsUserClarification(task, history);
 if (clarification.needed) {
 agentTask = `${formatAskUserNudge(clarification)}${task}`;
 reportEvent({
 type: "progress",
 role: "orchestrator",
 detail: `ask_user expected: ${clarification.topics.join(", ")}`,
 });
 tui?.appendSystem?.(
 `Перед правками Fuse должен спросить: **${clarification.topics.join(" · ")}**`,
 );
 }
 }

 const runInMode = async (activeMode: ExecutionMode): Promise<string> => {
 if (activeMode === "council-plan") {
 const mutationsBefore = workspaceMutationCount;
 const result = await runCouncilPlan({
 task: agentTask,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 approvePlan,
 requireWorkspaceChange: requiresWorkspaceChange,
 getWorkspaceMutationCount: () => workspaceMutationCount,
 });
 if (requiresWorkspaceChange && workspaceMutationCount === mutationsBefore) {
 throw new Error("Coder совета завершил работу, не изменив файлы проекта.");
 }
 const content = `${result.content}\n\nВыбранный план совета:\n${result.plan}\n\nРевью:\n${result.review}`;
 await appendSessionCouncil(active.info, "plan", [
 "# Council Plan",
 ...result.architectPlans.map((plan, index) => `## Architect ${index + 1}\n\n${plan}`),
 `## Judge Decision\n\n${result.judgment}`,
 `## Review\n\n${result.review}`,
 ].join("\n\n"));
 history = [...history, { role: "user", content: task }, { role: "assistant", content }];
 await recordSuccessfulTurn(task, content);
 return content;
 }
 if (activeMode === "council-review") {
 const result = await runCouncilReview({
 task: agentTask,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 });
 await appendSessionCouncil(active.info, "review", [
 result.content,
 ...result.reviews.map((review, index) => `## Reviewer ${index + 1}\n\n${review}`),
 ].join("\n\n"));
 history = [...history, { role: "user", content: task }, { role: "assistant", content: result.content }];
 await recordSuccessfulTurn(task, result.content);
 return result.content;
 }
 if (activeMode === "team") {
 const mutationsBefore = workspaceMutationCount;
 const result = await runTeam({
 task: agentTask,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 approvePlan,
 requireWorkspaceChange: requiresWorkspaceChange,
 getWorkspaceMutationCount: () => workspaceMutationCount,
 });
 if (requiresWorkspaceChange && workspaceMutationCount === mutationsBefore) {
 throw new Error("Coder команды завершил работу, не изменив файлы проекта.");
 }
 const content = `${result.content}\n\nReview:\n${result.review}`;
 history = [...history, { role: "user", content: task }, { role: "assistant", content }];
 await recordSuccessfulTurn(task, content);
 return content;
 }
 if (activeMode === "plan") {
 const planTask = `You are in Plan Mode for this request. Explore the repository with read-only tools, then call submit_plan with a concrete implementation plan (files, steps, risks, verification). Do not implement edits in this mode.

USER REQUEST:
${agentTask}`;
 const result = await runAgent({
 role: "orchestrator",
 task: planTask,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 });
 let content = result.content;
 if (planMode.approvedPlan) {
 content = `${result.content}\n\n---\n\nОдобренный план:\n\n${planMode.approvedPlan}`;
 // After an approved plan in /plan mode, switch sticky mode so the next message can implement.
 mode = "orchestrate";
 }
 history = result.history;
 await recordSuccessfulTurn(task, content);
 return content;
 }
 const role = activeMode === "direct" ? "coder" : "orchestrator";
 const mutationsBefore = workspaceMutationCount;
 let result = await runAgent({ role, task: agentTask, config, toolContext: context, history, onEvent: reportEvent });

 // Model asked to switch mode mid-task — restart once in the new pipeline.
 if (pendingModeRestart && role === "orchestrator") {
 const restart = pendingModeRestart;
 pendingModeRestart = undefined;
 modeSuggestionUsed = true;
 reportEvent({
 type: "progress",
 role: "orchestrator",
 detail: `restarting task in ${restart.mode}: ${restart.reason}`,
 });
 tui?.appendSystem?.(`Перезапуск в режиме **${restart.mode}**: ${restart.reason}`);
 if (restart.mode === "plan") {
 planMode.active = true;
 planMode.goal = task.split(/\r?\n/)[0].slice(0, 120);
 planMode.enteredAt = new Date().toISOString();
 planMode.approvedPlan = undefined;
 }
 return runInMode(restart.mode);
 }

 // If the agent entered plan mode and got an approved plan mid-task, allow a follow-up implement pass.
 if (planMode.approvedPlan && role === "orchestrator" && requiresWorkspaceChange && workspaceMutationCount === mutationsBefore) {
 reportEvent({ type: "progress", role: "orchestrator", detail: "Implementing approved plan after Plan Mode." });
 const approvedPlan = planMode.approvedPlan;
 const coder = await runAgent({
 role: "coder",
 task: `Implement the approved plan for the user request. Follow the plan and verify changes.\n\nUSER REQUEST:\n${task}\n\nAPPROVED PLAN:\n${approvedPlan}`,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 });
 if (workspaceMutationCount === mutationsBefore) {
 throw new Error(`Coder завершил работу, не изменив файлы проекта. Ответ модели: ${coder.content.slice(0, 1_000)}`);
 }
 planMode.approvedPlan = undefined;
 planMode.goal = undefined;
 history = coder.history;
 let implemented = coder.content;
 implemented = await maybeAppendAutoCritique(implemented, task, mutationsBefore);
 await recordSuccessfulTurn(task, implemented);
 return implemented;
 }
 if (role === "coder" && requiresWorkspaceChange && workspaceMutationCount === mutationsBefore && !planMode.active) {
 reportEvent({ type: "progress", role: "coder", detail: "Coder вернул текст без изменений. Повторяю запуск с обязательной записью файлов." });
 result = await runAgent({
 role: "coder",
 task: `${task}\n\nThe previous response did not modify the workspace. Use native workspace tools now. If this model cannot emit native tool calls, return ONLY this fallback JSON (no Markdown): {"jevio_tool_calls":[{"name":"write_file","arguments":{"path":"relative/path","content":"complete file content"}}]}. You may include multiple calls. Jevio will execute them with normal permissions, then you can verify the results.\n\nPREVIOUS RESPONSE:\n${result.content}`,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 });
 if (workspaceMutationCount === mutationsBefore) {
 throw new Error(`Coder дважды завершил работу, не изменив файлы проекта. Последний ответ: ${result.content.slice(0, 1_000)}`);
 }
 }
 if (role === "orchestrator" && requiresWorkspaceChange && workspaceMutationCount === mutationsBefore && !planMode.active) {
 reportEvent({ type: "progress", role: "orchestrator", detail: "Routing implementation to coder because the workspace was not modified." });
 const coder = await runAgent({
 role: "coder",
 task: `${task}\n\nThe orchestrator returned this context, but no workspace files were changed. Implement the request in the workspace now:\n${result.content}`,
 config,
 toolContext: context,
 history,
 onEvent: reportEvent,
 });
 if (workspaceMutationCount === mutationsBefore) {
 throw new Error(`Coder завершил работу, не изменив файлы проекта. Ответ модели: ${coder.content.slice(0, 1_000)}`);
 }
 history = coder.history;
 let implemented = coder.content;
 implemented = await maybeAppendAutoCritique(implemented, task, mutationsBefore);
 await recordSuccessfulTurn(task, implemented);
 return implemented;
 }
 history = result.history;
 let content = result.content;
 // After direct/orchestrate writes: lightweight critic (team/council already review).
 if (activeMode === "direct" || activeMode === "orchestrate") {
 content = await maybeAppendAutoCritique(content, task, mutationsBefore);
 }
 await recordSuccessfulTurn(task, content);
 return content;
 };

 return runInMode(effectiveMode);
 };
 const executeTask = (task: string): Promise<string> => withTraceSpan("jevio.task", {
 "jevio.project.id": projectIdentity.id,
 "jevio.session.id": active.info.id,
 "jevio.execution.mode": mode,
 "jevio.task.characters": task.length,
 "jevio.host": "cli",
 }, async () => executeTaskCore(task));

 const resumeSelectedSession = async (selected: LoadedSession): Promise<string> => {
 if (selected.info.path !== active.info.path) await discardEmptySession(active.info);
 active = selected;
 history = selected.history;
 context.todos = selected.todos;
 tui?.setTodos(selected.todos);
 return `Resumed ${active.info.id}: ${active.info.title} (${history.length} messages loaded)`;
 };
 const executeTaskWithFailureRecord = async (task: string): Promise<string> => {
 try {
 return await executeTask(task);
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 const failure = `Задача не завершена: ${message}`;
 history = [...history, { role: "user", content: task }, { role: "assistant", content: failure }];
 await appendSessionTurn(active.info, task, failure);
 throw error;
 }
 };
 const fixLatestCouncilReview = async (): Promise<string> => {
 turnVerifications = [];
 const review = await loadLatestCouncilReview(active.info);
 if (!review) throw new Error("В текущей сессии нет Council Review. Сначала запустите jevio review --council.");
 const task = `Исправь только подтвержденные judge findings из Council Review ниже. Не меняй несвязанный код. После исправлений запусти релевантные проверки и кратко перечисли их результаты.\n\n${review}`;
 const mutationsBefore = workspaceMutationCount;
 const result = await runAgent({ role: "coder", task, config, toolContext: context, history, onEvent: reportEvent });
 if (workspaceMutationCount === mutationsBefore) throw new Error("Coder finished without modifying the workspace.");
 history = result.history;
 await recordSuccessfulTurn("/fix-review", result.content);
 return result.content;
 };

 /** Post-write code critic (lighter than /council-review). */
 const runPostWriteCritique = async (userRequest?: string, focus?: string): Promise<CritiqueResult> => {
 reportEvent({ type: "progress", role: "reviewer", detail: "code critique" });
 const result = await runCritique({
 config,
 toolContext: context,
 userRequest,
 focus,
 history,
 onEvent: reportEvent,
 });
 lastCritique = result;
 return result;
 };

 const maybeAppendAutoCritique = async (
 content: string,
 userRequest: string,
 mutationsBefore: number,
 ): Promise<string> => {
 if (workspaceMutationCount <= mutationsBefore) return content;
 try {
 const critique = await runPostWriteCritique(userRequest);
 return `${content}\n\n---\n\n${formatCritiqueAppendix(critique)}`;
 } catch (error) {
 reportEvent({
 type: "thinking",
 role: "reviewer",
 detail: `critique skipped: ${(error as Error).message}`,
 });
 return content;
 }
 };

 const fixLatestCritique = async (): Promise<string> => {
 turnVerifications = [];
 const critique = lastCritique?.content
 ?? (await runPostWriteCritique()).content;
 const task = `Исправь findings из code critique ниже. Сначала Critical, потом важные Improvements если дешево. Не делай unrelated cleanup. После правок — git_diff / checks.\n\nCRITIQUE:\n${critique}`;
 const mutationsBefore = workspaceMutationCount;
 const result = await runAgent({ role: "coder", task, config, toolContext: context, history, onEvent: reportEvent });
 if (workspaceMutationCount === mutationsBefore) {
 throw new Error("Coder не изменил файлы после critique. Возможно, findings уже неактуальны — /critique ещё раз.");
 }
 history = result.history;
 let content = result.content;
 content = await maybeAppendAutoCritique(content, task, mutationsBefore);
 await recordSuccessfulTurn("/critique fix", content);
 return content;
 };
 const handleInteractiveInput = async (answer: string, useTuiPicker = false): Promise<{ output?: string; exit?: boolean }> => {
 const task = answer.trim();
 if (!task) return {};
 const [rawCommand, ...parts] = task.split(/\s+/);
 const raw = rawCommand.toLowerCase();
 const resolved = resolveSlashCommand(raw);
 const command = resolved ? `/${resolved.name}` : raw;
 const argument = parts.join(" ").trim();

 if (command === "/exit") return { exit: true };
 if (command === "/help") return { output: formatInteractiveHelp() };
 if (command === "/skills") {
 return {
 output: context.skills.length
 ? context.skills.map((skill) => `${skill.name}${skill.modelInvocable ? "" : " (только вручную)"}\n${skill.description}`).join("\n\n")
 : "Skills не найдены.",
 };
 }
 if (command === "/plugins") return { output: mcpPlugins.statusText() };
 if (command === "/todos" || command === "/todo") {
 const sub = (parts[0] ?? "show").toLowerCase();
 if (sub === "clear") {
 active.todos = [];
 context.todos = [];
 tui?.setTodos([]);
 await saveSessionTodos(active.info, []);
 return { output: "ToDo очищен." };
 }
 const items = active.todos ?? [];
 if (!items.length) {
 return {
 output: [
 "ToDo пуст.",
 "Модель заполняет его через tool update_todo.",
 "Для multi-step задач Fuse просит checklist до правок.",
 ].join("\n"),
 };
 }
 const done = items.filter((item) => item.status === "completed").length;
 const lines = items.map((item, index) => {
 const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
 return `${index + 1}. [${mark}] ${item.content}`;
 });
 return { output: `ToDo ${done}/${items.length}\n${lines.join("\n")}\n\n/todos clear — очистить` };
 }
 if (command === "/fix-review") return { output: await fixLatestCouncilReview() };
 if (command === "/critique") {
 const sub = (parts[0] ?? "").toLowerCase();
 try {
 if (sub === "fix") {
 return { output: await fixLatestCritique() };
 }
 const focus = sub === "focus"
 ? parts.slice(1).join(" ").trim() || undefined
 : argument || undefined;
 const critique = await runPostWriteCritique(undefined, focus);
 return { output: formatCritiqueAppendix(critique) };
 } catch (error) {
 return { output: `Critique failed: ${(error as Error).message}` };
 }
 }
 if (command === "/team") {
 mode = "team";
 planMode.active = false;
 if (argument) return { output: await executeTaskWithFailureRecord(argument) };
 return { output: "Mode: team (architect -> coder -> reviewer). Можно сразу: /team <задача>" };
 }
 if (command === "/council-plan") {
 mode = "council-plan";
 planMode.active = false;
 if (argument) return { output: await executeTaskWithFailureRecord(argument) };
 return { output: "Режим совета планирования: 3 architect -> judge -> coder -> reviewer. Можно: /council-plan <задача>" };
 }
 if (command === "/council-review") {
 mode = "council-review";
 planMode.active = false;
 if (argument) return { output: await executeTaskWithFailureRecord(argument) };
 return { output: "Режим совета ревью: security/correctness/tests reviewers -> judge. Можно: /council-review <задача>" };
 }
 if (command === "/plan") {
 mode = "plan";
 planMode.active = true;
 planMode.enteredAt = new Date().toISOString();
 planMode.approvedPlan = undefined;
 planMode.goal = argument || undefined;
 if (argument) return { output: await executeTaskWithFailureRecord(argument) };
 return {
 output: "Режим Plan Mode: исследование и submit_plan без правок. Можно сразу: /plan <задача>. После approve следующего плана режим вернётся к orchestrate.",
 };
 }
 if (command === "/direct") {
 mode = "direct";
 planMode.active = false;
 if (argument) return { output: await executeTaskWithFailureRecord(argument) };
 return { output: "Mode: direct (coder). Можно: /direct <задача>" };
 }
 if (command === "/orchestrate") {
 mode = "orchestrate";
 planMode.active = false;
 if (argument) return { output: await executeTaskWithFailureRecord(argument) };
 return { output: "Mode: orchestrate. Можно: /orchestrate <задача>" };
 }
 if (command === "/ideas") {
 const countMatch = /(?:^|\s)count=(\d{1,2})(?:\s|$)/i.exec(argument);
 const count = countMatch ? Number(countMatch[1]) : undefined;
 const topic = argument.replace(/(?:^|\s)count=\d{1,2}(?:\s|$)/gi, " ").trim() || undefined;
 try {
 reportEvent({ type: "thinking", role: "architect", detail: "idea generator" });
 const output = await generateIdeas({
 workspace: options.workspace,
 config,
 toolContext: context,
 topic,
 count,
 onEvent: reportEvent,
 });
 return { output };
 } catch (error) {
 return { output: `Ideas failed: ${(error as Error).message}` };
 }
 }
 if (command === "/kairos") {
 const sub = (parts[0] ?? "").toLowerCase();
 try {
 reportEvent({ type: "thinking", role: "orchestrator", detail: "kairos observation" });
 const result = await runKairos({
 workspace: options.workspace,
 config,
 toolContext: context,
 history,
 synthesize: sub === "full",
 onEvent: reportEvent,
 });
 if (sub === "status") {
 return {
 output: [
 result.summary,
 `signals: ${result.signals.length}`,
 `uncommitted: ${result.raw.uncommittedCount}`,
 `memory: ${result.raw.memoryCharacters} chars`,
 `dream queue: ${result.raw.pendingDreamSessions} sessions`,
 `at: ${result.observedAt}`,
 ].join("\n"),
 };
 }
 return { output: formatKairosReport(result, result.synthesis) };
 } catch (error) {
 return { output: `KAIROS failed: ${(error as Error).message}` };
 }
 }
 if (command === "/provider") {
 if (!argument) {
 const lines = [
 `Текущий: ${currentProvider()} / ${currentModel()}`,
 "",
 "Провайдеры:",
 ...Object.entries(config.providers).map(([name, provider]) => {
 const mark = name === currentProvider() || (currentProvider() === "mixed" && name === config.defaultProvider) ? "*" : " ";
 return ` ${mark} ${name} ${provider.baseUrl} default:${provider.defaultModel ?? "—"}`;
 }),
 "",
 "Смена: /provider <имя> · затем /models",
 ];
 return { output: lines.join("\n") };
 }
 const applyModel = parts[1]?.toLowerCase() === "model" || parts[1]?.toLowerCase() === "with-model";
 return { output: await selectProvider(parts[0] ?? "", applyModel) };
 }
 if (command === "/auto-mode" || command === "/autoroute") {
 const sub = (parts[0] ?? "").toLowerCase();
 if (sub === "on" || sub === "1" || sub === "true") autoRoute = true;
 else if (sub === "off" || sub === "0" || sub === "false") autoRoute = false;
 else if (sub === "status") {
 return {
 output: [
 `auto-mode: ${autoRoute ? "ON" : "OFF"}`,
 `sticky mode: ${mode}`,
 autoRoute
 ? "Пока sticky = orchestrate, host сам выбирает team/council/plan/direct под задачу."
 : "Только ручные /team /council-plan /plan /direct и suggest_mode с подтверждением.",
 ].join("\n"),
 };
 } else {
 autoRoute = !autoRoute;
 }
 return {
 output: autoRoute
 ? "auto-mode ON — Fuse сам заходит в team/council/plan при подходящих задачах. /auto-mode off чтобы выключить."
 : "auto-mode OFF — режимы только вручную (/team, /council-plan, …) или через confirm suggest_mode.",
 };
 }
 if (command === "/yolo") {
 const sub = (parts[0] ?? "").toLowerCase();
 if (sub === "on" || sub === "1" || sub === "true") yolo = true;
 else if (sub === "off" || sub === "0" || sub === "false") yolo = false;
 else if (sub === "status") {
 return {
 output: [
 `YOLO: ${yolo ? "ON" : "OFF"}`,
 `writes: ${context.autoApproveWrites ? "auto" : "ask"}`,
 `shell: ${context.autoApproveShell ? "auto" : "ask"} (${context.shellMode ?? "full"})`,
 `plugins: ${context.autoApprovePlugins ? "auto" : "ask"}`,
 `plans: ${yolo ? "auto-approve" : "ask"}`,
 ].join("\n"),
 };
 } else {
 yolo = !yolo;
 }
 applyYoloPermissions();
 tui?.refreshHeader();
 return {
 output: yolo
 ? "YOLO ON — auto-approve writes, shell (full), plugins и plans. /yolo off чтобы выключить."
 : "YOLO OFF — снова спрашиваю подтверждения. /yolo on чтобы включить.",
 };
 }
 if (command === "/models") {
 const sub = (parts[0] ?? "").trim();
 if (!sub || sub === "list") {
 // TUI opens the picker; text mode prints the list.
 if (useTuiPicker) return { output: "Выберите модель в списке." };
 try {
 const listed = await listModelsForProvider();
 const body = listed.models.length
 ? listed.models.map((model) => ` ${model === listed.current ? "*" : " "} ${model}`).join("\n")
 : " (пусто)";
 return {
 output: [
 `Провайдер: ${listed.provider}`,
 `Текущая: ${listed.current}`,
 "",
 "Модели:",
 body,
 listed.detail ? `\n${listed.detail}` : "",
 "",
 "Смена: /models <id>",
 ].filter(Boolean).join("\n"),
 };
 } catch (error) {
 return { output: `Models failed: ${(error as Error).message}` };
 }
 }
 if (sub === "status") return { output: modelsStatusText() };
 // /models <provider> <model-id> OR /models <model-id with spaces joined>
 if (parts.length >= 2 && config.providers[sub]) {
 return { output: await selectModel(parts.slice(1).join(" "), sub) };
 }
 return { output: await selectModel(parts.join(" ")) };
 }
 if (command === "/new") {
 await discardEmptySession(active.info);
 active = { info: await createSession(options.workspace), history: [], todos: [] };
 history = [];
 context.todos = [];
 tui?.setTodos([]);
 return { output: `Сессия ${active.info.id} создана` };
 }
 // /clear is TUI-only (screen wipe). Outside TUI treat as /new for convenience.
 if (command === "/clear") {
 if (useTuiPicker) return { output: "Экран очищен." };
 await discardEmptySession(active.info);
 active = { info: await createSession(options.workspace), history: [], todos: [] };
 history = [];
 context.todos = [];
 return { output: `Сессия ${active.info.id} создана (в TUI /clear только чистит экран; /new — новая сессия).` };
 }
 if (command === "/sessions" || command === "/resume") {
 if (!argument && useTuiPicker) return { output: "Выберите сессию в списке." };
 const selected = argument
 ? await loadSession(options.workspace, argument)
 : await pickSession(options.workspace, terminal);
 return selected ? { output: await resumeSelectedSession(selected) } : {};
 }
 if (command === "/title") {
 if (!argument) return { output: active.info.title };
 await renameSession(active.info, argument);
 return { output: `Title: ${active.info.title}` };
 }
 if (command === "/fork") {
 active = await forkSession(options.workspace, active.info);
 history = active.history;
 context.todos = active.todos;
 tui?.setTodos(active.todos);
 return { output: `Forked into ${active.info.id}` };
 }
 if (command === "/export-md") {
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
 const sub = (parts[0] ?? "").toLowerCase();
 if (!sub || sub === "help" || sub === "?") {
 const body = context.projectMemory?.trim();
 // Bare /memory: help + short preview (full dump via /memory show).
 if (!sub) {
 const preview = body
 ? `\n\n--- MEMORY.md (первые строки) ---\n${body.split(/\r?\n/).slice(0, 12).join("\n")}${body.split(/\r?\n/).length > 12 ? "\n…" : ""}`
 : "\n\nMEMORY.md пуст.";
 return { output: `${formatSubcommandHelp("memory")}${preview}` };
 }
 return { output: formatSubcommandHelp("memory") };
 }
 if (sub === "show" || sub === "list" || sub === "get") {
 return { output: context.projectMemory?.trim() || "Память проекта пуста. Добавь: /memory add <текст>" };
 }
 if (sub === "explain") {
 const records = await listMemoryProvenance(options.workspace, 5);
 return { output: formatMemoryExplanation(records, context.retrievedMemory, cogneeMemory.lastRecall) };
 }
 if (sub === "status") {
 const status = await cogneeMemory.status();
 return {
 output: [
 `Markdown: ${context.projectMemory?.trim() ? `loaded (${context.projectMemory.length} chars)` : "empty"}`,
 `Project: ${projectIdentity.id}`,
 `Cognee: ${status.enabled ? (status.available ? "connected" : "unavailable") : "disabled"}`,
 `Dataset: ${status.dataset}`,
 `Pipeline: ${status.pipelineStatus ?? "unknown"}`,
 `Detail: ${status.detail}`,
 "",
 "Подкоманды: /memory help",
 ].join("\n"),
 };
 }
 if (sub === "sync") {
 if (!cogneeMemory.enabled) return { output: "Cognee memory is disabled in jevio.config.json." };
 const document = await loadProjectMemory(options.workspace);
 const warning = await rememberCognee(document, "MEMORY.md", false);
 return { output: warning ?? `MEMORY.md synchronized with Cognee dataset ${cogneeMemory.dataset}.` };
 }
 if (sub === "improve") {
 if (!cogneeMemory.enabled) return { output: "Cognee memory is disabled in jevio.config.json." };
 try {
 await cogneeMemory.improve([active.info.id]);
 return { output: `Cognee improvement started for dataset ${cogneeMemory.dataset}.` };
 } catch (error) {
 return { output: `Cognee improvement failed: ${(error as Error).message}` };
 }
 }
 if (sub === "add") {
 const entry = parts.slice(1).join(" ").trim();
 if (!entry) return { output: "Использование: /memory add <текст>\nПример: /memory add Предпочитаем TypeScript strict" };
 const file = await appendProjectMemory(options.workspace, entry);
 context.projectMemory = await loadProjectMemory(options.workspace);
 const provenance = await recordMemoryProvenance("explicit_memory", entry, "Stored in project memory.", []);
 const warning = await rememberCognee(explicitMemoryDocument(entry, provenance), `explicit-${Date.now()}.md`, false, provenance?.id);
 return { output: `Memory updated: ${file}${warning ? `\n${warning}` : cogneeMemory.enabled ? "\nCognee synchronized." : ""}` };
 }
 if (sub === "replace") {
 const requestedId = parts[1]?.trim() ?? "";
 const replacement = parts.slice(2).join(" ").trim();
 if (!requestedId || !replacement) return { output: "Использование: /memory replace <record-id> <новый текст>" };
 const records = await listMemoryProvenance(options.workspace, 500);
 const matches = records.filter((record) => record.id === requestedId || record.id.startsWith(requestedId));
 if (!matches.length) return { output: `Memory record '${requestedId}' не найден.` };
 if (matches.length > 1) return { output: `Memory record '${requestedId}' неоднозначен. Укажи более длинный ID.` };
 const target = matches[0];
 if (supersededMemoryIds(records).includes(target.id)) return { output: `Memory record '${target.id}' уже заменён.` };
 let remoteCleanup = "";
 if (cogneeMemory.enabled && target.remote?.dataId) {
 try {
 const removed = await cogneeMemory.forgetData(target.remote.dataId, target.remote.datasetId);
 remoteCleanup = removed ? "\nOld Cognee source deleted." : "\nOld Cognee source was not found; recall filtering remains active.";
 } catch (error) {
 remoteCleanup = `\nOld Cognee source cleanup failed: ${(error as Error).message}. Recall filtering remains active.`;
 }
 }
 const file = await replaceProjectMemory(options.workspace, target.request, replacement, target.id);
 context.projectMemory = await loadProjectMemory(options.workspace);
 const provenance = await recordMemoryProvenance(
 "explicit_memory",
 replacement,
 `Supersedes memory record ${target.id}.`,
 [],
 [target.id],
 );
 const warning = await rememberCognee(explicitMemoryDocument(replacement, provenance), `replacement-${Date.now()}.md`, false, provenance?.id);
 return { output: `Memory record ${target.id} replaced: ${file}${remoteCleanup}${warning ? `\n${warning}` : cogneeMemory.enabled ? "\nCognee synchronized." : ""}` };
 }
 if (sub === "clear") {
 if (!(await confirm("Очистить память проекта?"))) return { output: "Очистка памяти отменена." };
 const file = await clearProjectMemory(options.workspace);
 await clearMemoryProvenance(options.workspace);
 context.projectMemory = "";
 let remote = "";
 if (cogneeMemory.enabled) {
 try {
 remote = await cogneeMemory.forget() ? " Cognee dataset deleted." : " Cognee dataset was already empty.";
 } catch (error) {
 remote = ` Cognee cleanup failed: ${(error as Error).message}`;
 }
 }
 return { output: `Память очищена: ${file}.${remote}` };
 }
 return {
 output: `Неизвестная подкоманда: /memory ${sub}\n\n${formatSubcommandHelp("memory")}`,
 };
 }
 if (command === "/dream") {
 const sub = (parts[0] ?? "").toLowerCase();
 if (sub === "status") {
 const status = await dreamStatus(options.workspace);
 return {
 output: [
 status.detail,
 `Последний сон: ${status.lastDreamedAt ?? "никогда"}`,
 `Отслеживается сессий: ${status.sessionsTracked}`,
 `В очереди: ${status.pendingSessions} сессий / ${status.pendingMessages} сообщений`,
 `MEMORY.md: ${status.memoryCharacters} символов`,
 ].join("\n"),
 };
 }
 try {
 reportEvent({ type: "thinking", role: "compactor", detail: "starting dream consolidation" });
 const result = await runDream({
 workspace: options.workspace,
 config,
 toolContext: context,
 force: sub === "force",
 onEvent: reportEvent,
 });
 context.projectMemory = await loadProjectMemory(options.workspace);
 const warning = await rememberCognee(result.memory, "MEMORY.md");
 return {
 output: [
 "💤 Fuse dream complete.",
 `Sessions: ${result.sessionsProcessed} · signals: ${result.signalCount} · new messages: ${result.newMessages}`,
 `MEMORY.md: ${result.previousMemoryCharacters} → ${result.memoryCharacters} chars`,
 `Wrote: ${result.memoryPath}`,
 `At: ${result.dreamedAt}`,
 warning ? warning : cogneeMemory.enabled ? "Cognee synchronized." : "Cognee disabled — Markdown only.",
 ].join("\n"),
 };
 } catch (error) {
 return { output: `Dream failed: ${(error as Error).message}` };
 }
 }
 // Unknown slash → help, never burn a model turn on a typo.
 if (task.startsWith("/") && !resolved) {
 return {
 output: `Неизвестная команда: ${rawCommand}\n\n${formatInteractiveHelp()}`,
 };
 }
 return { output: await executeTaskWithFailureRecord(task) };
 };

 try {
 if (options.command === "fix-review") {
 console.log(`\n${await fixLatestCouncilReview()}`);
 return;
 }
 if (options.task) {
 console.log(`\n${await executeTaskWithFailureRecord(options.task)}`);
 return;
 }

 if (process.stdin.isTTY && process.stdout.isTTY) {
 terminal?.close();
 tui = new InteractiveTui({
 workspace: options.workspace,
 submit: (input, signal) => {
 const previousSignal = context.signal;
 context.signal = signal;
 return handleInteractiveInput(input, true).finally(() => {
 if (context.signal === signal) context.signal = previousSignal;
 });
 },
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
 setMode: (next) => {
 mode = next;
 if (next === "plan") {
 planMode.active = true;
 planMode.enteredAt = new Date().toISOString();
 planMode.approvedPlan = undefined;
 planMode.goal = undefined;
 } else {
 planMode.active = false;
 }
 },
 getProvider: currentProvider,
 getModel: currentModel,
 getYolo: () => yolo,
 listProviders: async () => {
 const entries = Object.entries(config.providers);
 return Promise.all(entries.map(async ([name, provider]) => {
 let reachable: boolean | undefined;
 let modelCount: number | undefined;
 try {
 const models = await listProviderModels(provider.baseUrl, {
 apiKey: resolveProviderApiKey(name),
 timeoutMs: 1_500,
 });
 reachable = true;
 modelCount = models.length;
 } catch {
 reachable = false;
 }
 const activeModels = [...new Set(
 Object.values(config.roles)
 .filter((role) => (role.provider ?? config.defaultProvider) === name)
 .map((role) => role.model),
 )];
 return {
 name,
 baseUrl: provider.baseUrl,
 apiKeyEnv: provider.apiKeyEnv,
 defaultModel: provider.defaultModel,
 transport: provider.transport,
 toolMode: provider.toolMode,
 reachable,
 modelCount,
 activeModel: activeModels.length === 1 ? activeModels[0] : activeModels.length ? "mixed" : provider.defaultModel,
 };
 }));
 },
 selectProvider: async (name) => selectProvider(name, false),
 listModels: async (provider) => listModelsForProvider(provider),
 selectModel: async (model) => selectModel(model),
 addProvider,
 listRoleConfigs: async () => (Object.entries(config.roles) as Array<[RoleName, typeof config.roles[RoleName]]>).map(([role, settings]) => ({
 role,
 provider: settings.provider ?? config.defaultProvider,
 model: settings.model,
 })),
 listPlugins: async () => mcpPlugins.statusText(),
 configureRole,
 setupReport,
 });
 tui.setTodos(active.todos);
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
