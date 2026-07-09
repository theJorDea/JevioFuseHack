import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./types.ts";

const MAX_RESUMED_MESSAGES = 40;
const MAX_RESUMED_CHARACTERS = 120_000;
const NEW_SESSION_TITLE = "New session";

export interface SessionInfo {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface LoadedSession {
  info: SessionInfo;
  history: ChatMessage[];
}

function sessionDirectory(workspace: string): string {
  return path.join(workspace, ".jevio", "sessions");
}

function memoryPath(workspace: string): string {
  return path.join(workspace, ".jevio", "MEMORY.md");
}

function makeId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " ").slice(0, 200));
}

function parseScalar(value: string | undefined): string {
  if (!value) return "";
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.trim();
  }
}

function parseFrontmatter(document: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(document);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).flatMap((line) => {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    return field ? [[field[1], field[2]]] : [];
  }));
}

function messageBlock(role: "user" | "assistant", content: string): string {
  const safeContent = content.replaceAll("<!-- /jevio:message -->", "&lt;!-- /jevio:message --&gt;");
  const label = role === "user" ? "User" : "Assistant";
  return `\n<!-- jevio:message role=${role} -->\n## ${label}\n\n${safeContent.trimEnd()}\n<!-- /jevio:message -->\n`;
}

function parseMessages(document: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const pattern = /<!-- jevio:message role=(user|assistant) -->\r?\n## (?:User|Assistant)\r?\n\r?\n([\s\S]*?)\r?\n<!-- \/jevio:message -->/g;
  for (const match of document.matchAll(pattern)) {
    messages.push({ role: match[1] as "user" | "assistant", content: match[2] });
  }
  return messages;
}

function compactionBlock(summary: string): string {
  const safeSummary = summary.replaceAll("<!-- /jevio:compaction -->", "&lt;!-- /jevio:compaction --&gt;");
  return `\n<!-- jevio:compaction -->\n## Compacted Context\n\n${safeSummary.trimEnd()}\n<!-- /jevio:compaction -->\n`;
}

function parseEffectiveMessages(document: string): ChatMessage[] {
  const pattern = /<!-- jevio:compaction -->\r?\n## Compacted Context\r?\n\r?\n([\s\S]*?)\r?\n<!-- \/jevio:compaction -->/g;
  let latest: RegExpExecArray | null = null;
  for (let match = pattern.exec(document); match; match = pattern.exec(document)) latest = match;
  if (!latest || latest.index === undefined) return parseMessages(document);
  const afterCheckpoint = document.slice(latest.index + latest[0].length);
  return [
    { role: "user", content: `Compacted context from the earlier conversation:\n\n${latest[1]}` },
    { role: "assistant", content: "Understood. I will continue from this compacted context." },
    ...parseMessages(afterCheckpoint),
  ];
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_RESUMED_MESSAGES; index -= 1) {
    const content = String(messages[index].content ?? "");
    if (selected.length && characters + content.length > MAX_RESUMED_CHARACTERS) break;
    selected.unshift(messages[index]);
    characters += content.length;
  }
  return selected;
}

async function infoFromFile(file: string): Promise<SessionInfo> {
  const document = await readFile(file, "utf8");
  const metadata = parseFrontmatter(document);
  const fileStats = await stat(file);
  return {
    id: parseScalar(metadata.id) || path.basename(file, ".md"),
    title: parseScalar(metadata.title) || NEW_SESSION_TITLE,
    path: file,
    createdAt: parseScalar(metadata.createdAt) || fileStats.birthtime.toISOString(),
    updatedAt: fileStats.mtime.toISOString(),
    messageCount: parseMessages(document).length,
  };
}

export async function createSession(workspace: string, title = NEW_SESSION_TITLE): Promise<SessionInfo> {
  const directory = sessionDirectory(workspace);
  await mkdir(directory, { recursive: true });
  const id = makeId();
  const createdAt = new Date().toISOString();
  const file = path.join(directory, `${id}.md`);
  await writeFile(file, `---
id: ${yamlString(id)}
title: ${yamlString(title)}
createdAt: ${yamlString(createdAt)}
format: jevio-session-v1
---

# ${title}
`, "utf8");
  return { id, title, path: file, createdAt, updatedAt: createdAt, messageCount: 0 };
}

export async function appendSessionTurn(session: SessionInfo, user: string, assistant: string): Promise<void> {
  await appendFile(session.path, `${messageBlock("user", user)}${messageBlock("assistant", assistant)}`, "utf8");
  session.messageCount += 2;
  session.updatedAt = new Date().toISOString();
}

export async function appendSessionCompaction(
  session: SessionInfo,
  summary: string,
  retainedMessages: ChatMessage[],
): Promise<void> {
  const retained = retainedMessages.map((message) =>
    messageBlock(message.role as "user" | "assistant", String(message.content ?? "")),
  ).join("");
  await appendFile(session.path, `${compactionBlock(summary)}${retained}`, "utf8");
  session.messageCount += retainedMessages.length;
  session.updatedAt = new Date().toISOString();
}

export async function listSessions(workspace: string): Promise<SessionInfo[]> {
  const directory = sessionDirectory(workspace);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      sessions.push(await infoFromFile(path.join(directory, entry.name)));
    } catch {
      // A manually damaged transcript is skipped rather than breaking the picker.
    }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadSession(workspace: string, requested: string): Promise<LoadedSession> {
  const sessions = await listSessions(workspace);
  const info = requested === "latest"
    ? sessions[0]
    : sessions.find((session) => session.id === requested || session.id.startsWith(requested));
  if (!info) throw new Error(`Session '${requested}' was not found in this workspace.`);
  const document = await readFile(info.path, "utf8");
  return { info, history: trimHistory(parseEffectiveMessages(document)) };
}

export async function renameSession(session: SessionInfo, title: string): Promise<void> {
  const normalized = title.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  if (!normalized) throw new Error("Session title must not be empty.");
  const document = await readFile(session.path, "utf8");
  const updated = document.replace(/^title:.*$/m, `title: ${yamlString(normalized)}`).replace(/^# .*$/m, `# ${normalized}`);
  await writeFile(session.path, updated, "utf8");
  session.title = normalized;
  session.updatedAt = new Date().toISOString();
}

export async function forkSession(workspace: string, source: SessionInfo): Promise<LoadedSession> {
  const loaded = await loadSession(workspace, source.id);
  const effectiveHistory = loaded.history;
  const fork = await createSession(workspace, `${source.title} (fork)`);
  for (let index = 0; index < effectiveHistory.length; index += 2) {
    const user = effectiveHistory[index];
    const assistant = effectiveHistory[index + 1];
    if (user?.role === "user" && assistant?.role === "assistant") {
      await appendSessionTurn(fork, String(user.content ?? ""), String(assistant.content ?? ""));
    }
  }
  return { info: fork, history: effectiveHistory };
}

export async function exportSession(session: SessionInfo, destination: string): Promise<string> {
  let target = path.resolve(destination);
  try {
    if ((await stat(target)).isDirectory()) target = path.join(target, `jevio-export-${session.id.slice(0, 8)}.md`);
  } catch {}
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(session.path, target);
  return target;
}

export async function discardEmptySession(session: SessionInfo): Promise<void> {
  if (session.messageCount === 0) await rm(session.path, { force: true });
}

export async function loadProjectMemory(workspace: string): Promise<string> {
  try {
    return (await readFile(memoryPath(workspace), "utf8")).slice(0, 40_000);
  } catch {
    return "";
  }
}

export async function appendProjectMemory(workspace: string, content: string): Promise<string> {
  const normalized = content.trim();
  if (!normalized) throw new Error("Memory entry must not be empty.");
  const file = memoryPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  let existing = await loadProjectMemory(workspace);
  if (!existing) existing = "# Jevio Project Memory\n";
  const timestamp = new Date().toISOString();
  await writeFile(file, `${existing.trimEnd()}\n\n## ${timestamp}\n\n${normalized}\n`, "utf8");
  return file;
}

export async function clearProjectMemory(workspace: string): Promise<string> {
  const file = memoryPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "# Jevio Project Memory\n", "utf8");
  return file;
}

export { NEW_SESSION_TITLE };
