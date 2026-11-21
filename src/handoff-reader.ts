import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type Check = { label: string; outcome: "PASS" | "FAIL" | "UNKNOWN"; exitCode: number | null; callLine: number; resultLine: number | null; time?: string };
type Coverage = { unknown: number; damaged: number; unmatched: number };
type Evidence = { partial: boolean; checks: Check[]; edits: number[]; goalLine: number | null; coverage?: Coverage };
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const unavailable = () => new Error("Unsupported, ambiguous, oversized or unreadable local transcript.");
const FILE = 32 * 1024 * 1024, LINE = 1024 * 1024, ROWS = 50_000, EVENTS = 16_384;
const runners = ["npm run test", "npm test", "pnpm test", "yarn test", "node --test", "python -m pytest", "pytest", "cargo test", "go test"];
function command(v: unknown) {
  if (typeof v !== "string") return;
  const s = v.trimStart();
  const label = runners.find(r => s.startsWith(r) && (!s[r.length] || /[\s;&|<>]/.test(s[r.length])));
  if (!label) return;
  // Unparsed shell/runner syntax is evidence of an attempt only, not a test outcome.
  const args = s.slice(label.length);
  // Accept pytest's single literal selector as syntax, never as an exported label.
  const suffix = label.endsWith("pytest") ? args.replace(/[ \t]+-k[ \t]+[A-Za-z0-9_]+(?=[ \t]|$)/g, "") : args;
  const simple = /^(?:[ \t]+(?:[\w./][\w./-]*|-q|-v|--verbose))*[ \t]*$/.test(suffix) && !/[\r\n]/.test(s);
  return { label, simple };
}

// Only accept explicit zoned ISO timestamps, checking calendar fields before UTC conversion.
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 29) return;
  const m = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!m || m[0] !== value) return;
  const local = `${m[1]}.${(m[2] ?? "").padEnd(3, "0")}`;
  const utc = new Date(`${local}Z`);
  if (!Number.isFinite(+utc) || utc.toISOString() !== `${local}Z`) return;
  const iso = new Date(`${local}${m[3]}`).toISOString();
  return iso.length === 24 ? iso : undefined;
}

type Call = { line: number; time?: string; check?: ReturnType<typeof command>; edit: boolean; epoch: number; bg: boolean };
type Result = { line: number; time?: string; code: number | null; success: boolean; error: boolean; epoch: number; unfinished: boolean };

/** Reads only the caller-selected regular file. Errors deliberately omit untrusted text and paths. */
export async function readHandoffEvidence(file: string, workspace: string): Promise<Evidence> {
  try { return await read(file, workspace); } catch { throw unavailable(); }
}
async function read(file: string, workspace: string): Promise<Evidence> {
  const root = await realpath(workspace);
  const selected = path.resolve(file);
  if (!(await stat(root)).isDirectory() || await realpath(selected) !== selected) throw unavailable();
  const before = await lstat(selected, { bigint: true });
  if (!before.isFile()) throw unavailable();
  const handle = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > FILE || info.dev !== before.dev || info.ino !== before.ino || await realpath(selected) !== selected) throw unavailable();
    let matchedWorkspace = false;
    const nodes = new Map<string, { line: number; digest: string }>();
    const children = new Map<string | null, string>();
    const calls = new Map<string, Call>(), results = new Map<string, Result>(), conflicts = new Set<string>();
    const seenCalls = new Map<string, number>();
    let session: string | undefined, line = 0, partial = false, goalLine: number | null = null;
    let cutoff = Infinity, epoch = 0, events = 0, supported = false;
    // unknown/damaged count distinct source lines. unmatched counts distinct unresolved tool IDs.
    const coverage: Coverage = { unknown: 0, damaged: 0, unmatched: 0 };
    const last = { unknown: 0, damaged: 0 };
    const gap = (kind?: keyof typeof last) => {
      if (kind && last[kind] !== line) { coverage[kind]++; last[kind] = line; }
      partial = true; epoch++;
    };
    async function consume(bytes: Buffer) {
      if (++line > ROWS) throw unavailable();
      let row: unknown;
      try { row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { gap("damaged"); return; }
      if (!obj(row)) { gap("damaged"); return; }
      if (row.cwd !== undefined) {
        // Compare to a trusted canonical spelling. Never stat/resolve a transcript-supplied path.
        if (row.cwd !== root) throw unavailable();
        matchedWorkspace = true;
      }
      if (row.sessionId !== undefined) {
        if (!id(row.sessionId) || (session !== undefined && session !== row.sessionId)) throw unavailable();
        session = row.sessionId;
      }
      if (row.type !== "user" && row.type !== "assistant") {
        if (!["system", "progress", "file-history-snapshot", "queue-operation", "last-prompt"].includes(String(row.type))) gap("unknown");
        return;
      }
      if (!row.cwd) throw unavailable();
      if (row.isSidechain || row.agentId) { gap(); return; }
      if (!obj(row.message) || row.message.role !== row.type) { gap("damaged"); return; }
      if (row.parentUuid !== undefined && row.parentUuid !== null && !id(row.parentUuid)) { gap(); cutoff = 0; return; }
      if (row.uuid !== undefined && !id(row.uuid)) { gap(); cutoff = 0; return; }
      if (id(row.uuid)) {
        const digest = createHash("sha256").update(bytes).digest("hex"), old = nodes.get(row.uuid);
        if (old) { if (old.digest !== digest) { cutoff = Math.min(cutoff, old.line - 1); gap(); } return; }
        if (row.parentUuid !== undefined) {
          const parent = row.parentUuid as string | null;
          if (children.has(parent)) { cutoff = Math.min(cutoff, parent === null ? 0 : nodes.get(parent)?.line ?? 0); gap(); }
          children.set(parent, row.uuid);
          // A missing predecessor may be an omitted system node; never join tool pairs across it.
          if (parent !== null && !nodes.has(parent)) gap();
        }
        nodes.set(row.uuid, { digest, line });
      } else if (row.parentUuid !== undefined) { gap(); cutoff = 0; return; }
      const content = row.message.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks)) { gap("damaged"); return; }
      const resultCount = blocks.filter(b => obj(b) && b.type === "tool_result").length;
      for (const b of blocks) {
        if (++events > EVENTS) throw unavailable();
        if (!obj(b)) { gap(); continue; }
        if (b.type === "text" && typeof b.text === "string") {
          supported = true;
          if (row.type === "user" && !row.isMeta && !row.isCompactSummary && resultCount === 0 && b.text.trim()) goalLine ??= line;
        } else if (row.type === "assistant" && b.type === "tool_use" && id(b.id) && typeof b.name === "string" && obj(b.input)) {
          supported = true;
          if (seenCalls.has(b.id) || results.has(b.id)) { conflicts.add(b.id); partial = true; }
          seenCalls.set(b.id, epoch);
          const check = b.name === "Bash" ? command(b.input.command) : undefined;
          const edit = b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit";
          if ((check || edit) && !calls.has(b.id)) calls.set(b.id, { line, time: isoTime(row.timestamp), edit, check, epoch, bg: !!b.input.run_in_background });
        } else if (row.type === "user" && b.type === "tool_result" && id(b.tool_use_id)) {
          supported = true;
          if (!seenCalls.has(b.tool_use_id) || results.has(b.tool_use_id)) { partial = true; conflicts.add(b.tool_use_id); }
          const meta = resultCount === 1 && obj(row.toolUseResult) ? row.toolUseResult : {};
          const codes = [meta.exitCode, b.exitCode].filter(v => v !== undefined);
          const code = codes.length && codes.every(v => Number.isSafeInteger(v) && v === codes[0]) ? codes[0] as number : null;
          const invalidCode = codes.length > 0 && code === null;
          const unfinished = invalidCode || !!(meta.interrupted || meta.backgroundTaskId || meta.background_task_id);
          results.set(b.tool_use_id, { line, time: isoTime(row.timestamp), code, error: b.is_error === true, success: (b.is_error === false || b.is_error === undefined) && (b.content !== undefined || row.toolUseResult !== undefined), epoch, unfinished });
        } else if (b.type !== "thinking" && b.type !== "redacted_thinking") gap(["text", "tool_result", "tool_use"].includes(String(b.type)) ? "damaged" : "unknown");
      }
    }
    let pending = Buffer.alloc(0), total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const data = chunk as Buffer;
      if ((total += data.length) > FILE) throw unavailable();
      let start = 0;
      while (start < data.length) {
        const end = data.indexOf(10, start), part = data.subarray(start, end < 0 ? data.length : end);
        if (pending.length + part.length > LINE) throw unavailable();
        pending = pending.length ? Buffer.concat([pending, part]) : part;
        if (end < 0) break;
        await consume(pending); pending = Buffer.alloc(0); start = end + 1;
      }
    }
    if (pending.length) await consume(pending);
    if (!supported || !matchedWorkspace) throw unavailable();
    const unmatched = new Set(conflicts);
    for (const [key, callEpoch] of seenCalls) if (results.get(key)?.epoch !== callEpoch) unmatched.add(key);
    const checks: Check[] = [], edits: number[] = [];
    for (const [key, call] of calls) {
      if (call.line > cutoff) continue;
      const r = results.get(key);
      const paired = r && !conflicts.has(key) && r.epoch === call.epoch && r.line > call.line && r.line <= cutoff ? r : null;
      if (!paired) unmatched.add(key);
      if (call.edit && paired?.success && !paired.unfinished && (paired.code === null || paired.code === 0)) edits.push(paired.line);
      if (call.check) {
        const code = paired && !paired.unfinished && !call.bg && call.check.simple && (paired.success || paired.error) && !(paired.error && paired.code === 0) ? paired.code : null;
        // time describes resultLine when present, otherwise callLine. Never silently substitute one for the other.
        const time = paired ? paired.time : call.time;
        checks.push({ ...(time ? { time } : {}), label: call.check.label, callLine: call.line, resultLine: paired?.line ?? null, exitCode: code, outcome: code === null ? "UNKNOWN" : code === 0 ? "PASS" : "FAIL" });
      }
    }
    coverage.unmatched = unmatched.size;
    const hasGaps = coverage.unknown + coverage.damaged + coverage.unmatched > 0;
    return { ...(hasGaps ? { coverage } : {}), partial: partial || hasGaps, checks, edits: [...new Set(edits)].sort((a,b) => a-b), goalLine: goalLine !== null && goalLine <= cutoff ? goalLine : null };
  } finally { await handle.close(); }
}
