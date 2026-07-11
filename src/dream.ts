import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAgent, type AgentEvent } from "./agent.ts";
import {
  listSessions,
  loadProjectMemory,
  loadSession,
  writeProjectMemory,
  type SessionInfo,
} from "./session.ts";
import type { ChatMessage, JevioConfig, ToolContext } from "./types.ts";

const DREAM_STATE_VERSION = 1;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_SIGNAL_CHARACTERS = 48_000;
const DEFAULT_MAX_MEMORY_CHARACTERS = 24_000;
const PER_MESSAGE_CAP = 1_200;

export interface DreamState {
  version: number;
  lastDreamedAt?: string;
  /** sessionId -> messageCount snapshot at last successful dream */
  sessions: Record<string, number>;
}

export interface DreamSignal {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  newMessages: number;
  excerpt: string;
}

export interface DreamGatherResult {
  memory: string;
  signals: DreamSignal[];
  totalCharacters: number;
  skippedEmpty: boolean;
}

export interface DreamResult {
  memoryPath: string;
  memory: string;
  signalCount: number;
  sessionsProcessed: number;
  newMessages: number;
  previousMemoryCharacters: number;
  memoryCharacters: number;
  dreamedAt: string;
}

export interface DreamStatus {
  lastDreamedAt?: string;
  sessionsTracked: number;
  pendingSessions: number;
  pendingMessages: number;
  memoryCharacters: number;
  detail: string;
}

function dreamStatePath(workspace: string): string {
  return path.join(path.resolve(workspace), ".jevio", "dream-state.json");
}

export async function loadDreamState(workspace: string): Promise<DreamState> {
  try {
    const raw = JSON.parse(await readFile(dreamStatePath(workspace), "utf8")) as Partial<DreamState>;
    if (!raw || typeof raw !== "object") return { version: DREAM_STATE_VERSION, sessions: {} };
    const sessions: Record<string, number> = {};
    if (raw.sessions && typeof raw.sessions === "object") {
      for (const [id, count] of Object.entries(raw.sessions)) {
        if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
          sessions[id] = Math.floor(count);
        }
      }
    }
    return {
      version: DREAM_STATE_VERSION,
      lastDreamedAt: typeof raw.lastDreamedAt === "string" ? raw.lastDreamedAt : undefined,
      sessions,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: DREAM_STATE_VERSION, sessions: {} };
    }
    return { version: DREAM_STATE_VERSION, sessions: {} };
  }
}

export async function saveDreamState(workspace: string, state: DreamState): Promise<void> {
  const file = dreamStatePath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    version: DREAM_STATE_VERSION,
    lastDreamedAt: state.lastDreamedAt,
    sessions: state.sessions,
  }, null, 2)}\n`, "utf8");
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function formatMessageExcerpt(messages: ChatMessage[], fromIndex: number): string {
  const parts: string[] = [];
  for (let index = fromIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const label = message.role === "user" ? "User" : "Assistant";
    parts.push(`### ${label}\n\n${clip(String(message.content ?? ""), PER_MESSAGE_CAP)}`);
  }
  return parts.join("\n\n");
}

export function pendingDreamWork(
  sessions: SessionInfo[],
  state: DreamState,
): Array<{ session: SessionInfo; seenCount: number; newMessages: number }> {
  return sessions
    .map((session) => {
      const seenCount = state.sessions[session.id] ?? 0;
      const newMessages = Math.max(0, session.messageCount - seenCount);
      return { session, seenCount, newMessages };
    })
    .filter((item) => item.newMessages > 0)
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
}

export async function gatherDreamSignals(
  workspace: string,
  options: {
    maxSessions?: number;
    maxCharacters?: number;
    state?: DreamState;
  } = {},
): Promise<DreamGatherResult> {
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const maxCharacters = Math.max(2_000, options.maxCharacters ?? DEFAULT_MAX_SIGNAL_CHARACTERS);
  const state = options.state ?? await loadDreamState(workspace);
  const memory = await loadProjectMemory(workspace);
  const sessions = await listSessions(workspace);
  const pending = pendingDreamWork(sessions, state).slice(0, maxSessions);

  const signals: DreamSignal[] = [];
  let totalCharacters = 0;

  for (const item of pending) {
    if (totalCharacters >= maxCharacters) break;
    try {
      const loaded = await loadSession(workspace, item.session.id);
      // Prefer the stored full transcript path: loadSession trims history for model resume.
      // For dreaming we still use loaded.history as a practical signal source.
      const fromIndex = Math.max(0, loaded.history.length - item.newMessages);
      const excerpt = formatMessageExcerpt(loaded.history, fromIndex);
      if (!excerpt.trim()) continue;
      const remaining = maxCharacters - totalCharacters;
      const clipped = clip(excerpt, remaining);
      if (!clipped) continue;
      signals.push({
        sessionId: item.session.id,
        title: item.session.title,
        updatedAt: item.session.updatedAt,
        messageCount: item.session.messageCount,
        newMessages: item.newMessages,
        excerpt: clipped,
      });
      totalCharacters += clipped.length;
    } catch {
      // Skip damaged transcripts; dreaming should never block the host.
    }
  }

  return {
    memory,
    signals,
    totalCharacters,
    skippedEmpty: signals.length === 0,
  };
}

export async function dreamStatus(workspace: string): Promise<DreamStatus> {
  const state = await loadDreamState(workspace);
  const memory = await loadProjectMemory(workspace);
  const sessions = await listSessions(workspace);
  const pending = pendingDreamWork(sessions, state);
  const pendingMessages = pending.reduce((sum, item) => sum + item.newMessages, 0);
  let detail = "Готово к сну: нет новых сообщений для консолидации.";
  if (pending.length) {
    detail = `Ожидает сна: ${pending.length} сессий, ~${pendingMessages} новых сообщений.`;
  } else if (!state.lastDreamedAt) {
    detail = "Ещё не было /dream. После нескольких задач запустите /dream.";
  }
  return {
    lastDreamedAt: state.lastDreamedAt,
    sessionsTracked: Object.keys(state.sessions).length,
    pendingSessions: pending.length,
    pendingMessages,
    memoryCharacters: memory.length,
    detail,
  };
}

function buildDreamHistory(gathered: DreamGatherResult): ChatMessage[] {
  const signalBlocks = gathered.signals.map((signal, index) => [
    `## Signal ${index + 1}: ${signal.title}`,
    `session: ${signal.sessionId}`,
    `updated: ${signal.updatedAt}`,
    `newMessages: ${signal.newMessages}`,
    "",
    signal.excerpt,
  ].join("\n")).join("\n\n---\n\n");

  const currentMemory = gathered.memory.trim() || "(empty — start a new durable project memory)";

  return [
    {
      role: "user",
      content: `You are consolidating durable project memory for a coding agent (the "dream" pass).

## Current MEMORY.md

${currentMemory}

## New session signals since the last dream

${signalBlocks || "(no new signals)"}

## Your job

Produce an updated durable MEMORY.md body for this project.

Rules:
1. Keep only durable facts: conventions, decisions, architecture notes, recurring pitfalls, important paths, user preferences, open risks.
2. Merge duplicates; prefer newer confirmed facts when they supersede old ones.
3. Drop transient chatter, one-off tool noise, and speculative guesses.
4. Preserve explicit user instructions and preferences unless the new signals clearly reverse them.
5. Keep the document concise and scannable with Markdown headings and short bullets.
6. Do not invent repository facts that are not supported by current memory or the new signals.
7. Target under ${DEFAULT_MAX_MEMORY_CHARACTERS} characters.

Return only the Markdown body for MEMORY.md. Start with a top-level heading. No preamble.`,
    },
    {
      role: "assistant",
      content: "I will consolidate durable project memory from the current MEMORY.md and the new session signals.",
    },
  ];
}

function normalizeDreamMemory(content: string): string {
  let text = content.trim();
  if (!text || text === "The model returned an empty response.") {
    throw new Error("The dream model returned no usable memory.");
  }
  // Strip accidental fences if a model wraps the document.
  const fenced = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith("#")) text = `# Jevio Project Memory\n\n${text}`;
  return `${text.trim()}\n`.slice(0, DEFAULT_MAX_MEMORY_CHARACTERS);
}

export async function runDream(options: {
  workspace: string;
  config: JevioConfig;
  toolContext: ToolContext;
  maxSessions?: number;
  maxCharacters?: number;
  force?: boolean;
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
}): Promise<DreamResult> {
  const state = await loadDreamState(options.workspace);
  options.onEvent?.({ type: "thinking", role: "compactor", detail: "dream: orient (read MEMORY.md)" });
  const gathered = await gatherDreamSignals(options.workspace, {
    maxSessions: options.maxSessions,
    maxCharacters: options.maxCharacters,
    state,
  });

  if (gathered.skippedEmpty && !options.force) {
    throw new Error("Нечего консолидировать: нет новых сообщений с прошлого /dream. Используйте /dream force, чтобы пересобрать MEMORY.md из текущих сессий.");
  }

  // force with no pending: re-dream from most recent sessions regardless of state
  let effective = gathered;
  if (gathered.skippedEmpty && options.force) {
    const emptyState: DreamState = { version: DREAM_STATE_VERSION, sessions: {} };
    effective = await gatherDreamSignals(options.workspace, {
      maxSessions: options.maxSessions,
      maxCharacters: options.maxCharacters,
      state: emptyState,
    });
    if (effective.skippedEmpty && !effective.memory.trim()) {
      throw new Error("Нечего консолидировать: нет сессий и MEMORY.md пуст.");
    }
    // If only memory exists, still allow a prune/rewrite pass.
    if (effective.skippedEmpty) {
      effective = {
        ...effective,
        signals: [{
          sessionId: "force-prune",
          title: "Force prune",
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          newMessages: 0,
          excerpt: "No new session signals. Rewrite MEMORY.md more tightly while preserving durable facts and user preferences.",
        }],
        skippedEmpty: false,
      };
    }
  }

  options.onEvent?.({
    type: "thinking",
    role: "compactor",
    detail: `dream: gather (${effective.signals.length} signals, ~${effective.totalCharacters} chars)`,
  });

  options.onEvent?.({ type: "thinking", role: "compactor", detail: "dream: consolidate durable memory" });
  const history = buildDreamHistory(effective);
  const result = await (options.runner ?? runAgent)({
    role: "compactor",
    task: "Consolidate durable project memory as instructed in the conversation history. Return only the MEMORY.md Markdown body.",
    config: options.config,
    toolContext: options.toolContext,
    history,
    maxTurns: 1,
    onEvent: options.onEvent,
  });

  const memory = normalizeDreamMemory(result.content);
  const memoryPath = await writeProjectMemory(options.workspace, memory);
  const dreamedAt = new Date().toISOString();

  const nextSessions = { ...state.sessions };
  for (const signal of effective.signals) {
    if (signal.sessionId === "force-prune") continue;
    nextSessions[signal.sessionId] = signal.messageCount;
  }
  // Also mark sessions that were pending but empty after load as processed at current count
  const pending = pendingDreamWork(await listSessions(options.workspace), state);
  for (const item of pending.slice(0, options.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
    if (!(item.session.id in nextSessions) || (nextSessions[item.session.id] ?? 0) < item.session.messageCount) {
      // Only advance if we actually included it or had no excerpt
      if (effective.signals.some((signal) => signal.sessionId === item.session.id)) {
        nextSessions[item.session.id] = item.session.messageCount;
      }
    }
  }

  await saveDreamState(options.workspace, {
    version: DREAM_STATE_VERSION,
    lastDreamedAt: dreamedAt,
    sessions: nextSessions,
  });

  options.onEvent?.({ type: "thinking", role: "compactor", detail: "dream: write MEMORY.md and prune state" });

  const newMessages = effective.signals.reduce((sum, signal) => sum + signal.newMessages, 0);
  return {
    memoryPath,
    memory,
    signalCount: effective.signals.length,
    sessionsProcessed: effective.signals.filter((signal) => signal.sessionId !== "force-prune").length,
    newMessages,
    previousMemoryCharacters: gathered.memory.length,
    memoryCharacters: memory.length,
    dreamedAt,
  };
}
