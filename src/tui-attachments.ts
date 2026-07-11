import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./tools.ts";

const DEFAULT_MAX_FILE_BYTES = 48_000;
const DEFAULT_MAX_TOTAL_BYTES = 120_000;
const DEFAULT_MAX_FILES = 8;

/**
 * Extract @file mentions from user text.
 * Supports: @src/foo.ts @"path with spaces.ts" @./bar
 * Skips emails (user@host) and pure numbers.
 */
export function extractAtMentions(text: string): string[] {
 const found: string[] = [];
 const seen = new Set<string>();
 const pattern = /@"([^"]+)"|@((?:\.\.?\/)?[^\s@]+)/g;
 let match: RegExpExecArray | null;
 while ((match = pattern.exec(text)) !== null) {
 const raw = (match[1] ?? match[2] ?? "").trim();
 if (!raw) continue;
 const atIndex = match.index ?? 0;
 // Skip emails: char before @ is part of local-part (user@host.com)
 if (atIndex > 0 && /[A-Za-z0-9._%+-]/.test(text[atIndex - 1]!)) continue;
 // Skip bare @handles without path or extension (@todo, @alice)
 if (!match[1] && !/[./\\]/.test(raw) && !/\.[A-Za-z0-9]{1,12}$/.test(raw)) continue;
 const key = raw.replace(/\\/g, "/");
 if (seen.has(key)) continue;
 seen.add(key);
 found.push(raw);
 }
 return found;
}

export interface AtAttachmentResult {
 /** Paths successfully loaded (workspace-relative, posix-ish). */
 loaded: string[];
 /** Mentions that could not be read. */
 missing: string[];
 /** Markdown block to append for the model. */
 contextBlock: string;
 /** Total characters of attached content. */
 totalCharacters: number;
}

/**
 * Resolve @mentions under the workspace and load file contents for the model.
 */
export async function loadAtAttachments(
 workspace: string,
 text: string,
 options: {
 maxFileBytes?: number;
 maxTotalBytes?: number;
 maxFiles?: number;
 } = {},
): Promise<AtAttachmentResult> {
 const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
 const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
 const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
 const mentions = extractAtMentions(text).slice(0, maxFiles);
 const loaded: string[] = [];
 const missing: string[] = [];
 const parts: string[] = [];
 let totalCharacters = 0;

 for (const mention of mentions) {
 try {
 const absolute = await resolveWorkspacePath(workspace, mention);
 const info = await stat(absolute);
 if (!info.isFile()) {
 missing.push(mention);
 continue;
 }
 if (info.size > maxFileBytes) {
 missing.push(`${mention} (too large: ${info.size} bytes)`);
 continue;
 }
 let content = await readFile(absolute, "utf8");
 // Skip binary-ish content
 if (content.includes("\0")) {
 missing.push(`${mention} (binary)`);
 continue;
 }
 if (totalCharacters + content.length > maxTotalBytes) {
 const remaining = Math.max(0, maxTotalBytes - totalCharacters);
 if (remaining < 200) {
 missing.push(`${mention} (attachment budget full)`);
 continue;
 }
 content = `${content.slice(0, remaining)}\n… [truncated]`;
 }
 const relative = path.relative(path.resolve(workspace), absolute).replace(/\\/g, "/");
 loaded.push(relative);
 totalCharacters += content.length;
 parts.push(`### ${relative}\n\`\`\`\n${content}\n\`\`\``);
 } catch {
 missing.push(mention);
 }
 }

 const contextBlock = parts.length
 ? [
 "## Attached files (from @mentions)",
 "The user referenced these workspace files. Prefer them as primary context.",
 "",
 ...parts,
 ].join("\n")
 : "";

 return { loaded, missing, contextBlock, totalCharacters };
}

/** Combine original user message with attached file context for the agent. */
export function composeMessageWithAttachments(userText: string, attachment: AtAttachmentResult): string {
 if (!attachment.contextBlock) return userText;
 return `${userText.trim()}\n\n---\n\n${attachment.contextBlock}`;
}
