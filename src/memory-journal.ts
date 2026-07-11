import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MemoryRecallSnapshot, VerificationRecord } from "./types.ts";
import type { MemoryWriteReceipt } from "./memory.ts";

const execFileAsync = promisify(execFile);
const MAX_REQUEST_CHARACTERS = 2_000;
const MAX_RESULT_CHARACTERS = 4_000;
const MAX_VERIFICATION_SUMMARY_CHARACTERS = 1_000;

export interface MemoryProvenanceRecord {
  id: string;
  kind: "completed_task" | "explicit_memory";
  createdAt: string;
  projectId?: string;
  sessionId: string;
  request: string;
  result: string;
  repositoryHead?: string;
  workingTreeFiles: string[];
  verifications: VerificationRecord[];
  supersedes?: string[];
  remote?: MemoryWriteReceipt;
}

interface MemoryRemoteReceiptEntry {
  kind: "remote_receipt";
  recordId: string;
  attachedAt: string;
  remote: MemoryWriteReceipt;
}

function journalPath(workspace: string): string {
  return path.join(path.resolve(workspace), ".jevio", "memory-log.jsonl");
}

async function gitOutput(workspace: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: workspace,
      windowsHide: true,
      maxBuffer: 200_000,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

function changedFiles(status: string | undefined): string[] {
  if (!status) return [];
  return [...new Set(status.split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean))]
    .slice(0, 100);
}

function boundedVerifications(records: VerificationRecord[]): VerificationRecord[] {
  return records.slice(-20).map((record) => ({
    command: record.command.slice(0, 500),
    exitCode: record.exitCode,
    summary: record.summary.slice(0, MAX_VERIFICATION_SUMMARY_CHARACTERS),
  }));
}

export async function appendMemoryProvenance(
  workspace: string,
  input: Pick<MemoryProvenanceRecord, "kind" | "sessionId" | "request" | "result" | "verifications"> & {
    projectId?: string;
    supersedes?: string[];
  },
): Promise<MemoryProvenanceRecord> {
  const [repositoryHead, status] = await Promise.all([
    gitOutput(workspace, ["rev-parse", "HEAD"]),
    gitOutput(workspace, ["status", "--short", "--untracked-files=all"]),
  ]);
  const record: MemoryProvenanceRecord = {
    id: randomUUID(),
    kind: input.kind,
    createdAt: new Date().toISOString(),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    sessionId: input.sessionId,
    request: input.request.trim().slice(0, MAX_REQUEST_CHARACTERS),
    result: input.result.trim().slice(0, MAX_RESULT_CHARACTERS),
    ...(repositoryHead ? { repositoryHead } : {}),
    workingTreeFiles: changedFiles(status),
    verifications: boundedVerifications(input.verifications),
    ...(input.supersedes?.length ? { supersedes: [...new Set(input.supersedes.map((id) => id.trim()).filter(Boolean))] } : {}),
  };
  const file = journalPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function listMemoryProvenance(workspace: string, limit = 5): Promise<MemoryProvenanceRecord[]> {
  try {
    const document = await readFile(journalPath(workspace), "utf8");
    const entries = document.trim().split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line) as MemoryProvenanceRecord | MemoryRemoteReceiptEntry];
      } catch {
        return [];
      }
    });
    const receipts = new Map(entries.flatMap((entry) => entry.kind === "remote_receipt" && typeof entry.recordId === "string"
      ? [[entry.recordId, entry.remote] as const]
      : []));
    return entries.reverse().flatMap((record) => record.kind !== "remote_receipt" && typeof record.id === "string" && typeof record.sessionId === "string"
      ? [{ ...record, ...(receipts.has(record.id) ? { remote: receipts.get(record.id) } : {}) }]
      : []).slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
  } catch {
    return [];
  }
}

export async function attachMemoryRemoteReceipt(
  workspace: string,
  recordId: string,
  remote: MemoryWriteReceipt | undefined,
): Promise<void> {
  if (!remote || !recordId.trim()) return;
  const entry: MemoryRemoteReceiptEntry = {
    kind: "remote_receipt",
    recordId: recordId.trim(),
    attachedAt: new Date().toISOString(),
    remote,
  };
  const file = journalPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

export function supersededMemoryIds(records: MemoryProvenanceRecord[]): string[] {
  return [...new Set(records.flatMap((record) => record.supersedes ?? []).filter(Boolean))];
}

export async function clearMemoryProvenance(workspace: string): Promise<void> {
  const file = journalPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "", "utf8");
}

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

export function formatMemoryExplanation(
  records: MemoryProvenanceRecord[],
  recalledMemory?: string,
  snapshot?: MemoryRecallSnapshot,
): string {
  let recall = recalledMemory?.trim()
    ? `Последний recall:\n${recalledMemory.trim().slice(0, 2_000)}`
    : "Последний recall: релевантная память не найдена.";
  if (snapshot) {
    const header = [
      `Запрос: ${oneLine(snapshot.query, 300)}`,
      `Dataset: ${snapshot.dataset}`,
      `Session: ${snapshot.sessionId ?? "не указана"}`,
      `Время: ${snapshot.recalledAt}`,
    ].join("\n");
    const fragments = snapshot.items.length
      ? snapshot.items.map((item, index) => {
        const metadata = [
          `source=${item.source}`,
          item.dataset ? `dataset=${item.dataset}` : undefined,
          item.datasetId ? `datasetId=${item.datasetId}` : undefined,
          item.sessionId ? `session=${item.sessionId}` : undefined,
          item.score !== undefined ? `score=${item.score}` : undefined,
          item.timestamp ? `timestamp=${item.timestamp}` : undefined,
        ].filter(Boolean).join(" · ");
        return `${index + 1}. ${metadata}\n   ${oneLine(item.text, 500)}`;
      }).join("\n\n")
      : "Фрагменты: совпадений нет.";
    recall = `Последний recall:\n${header}\n\n${fragments}`;
  }
  if (!records.length) return `${recall}\n\nЛокальный журнал provenance пуст.`;
  const replacementById = new Map<string, string>();
  records.forEach((record) => record.supersedes?.forEach((id) => {
    if (!replacementById.has(id)) replacementById.set(id, record.id);
  }));
  const entries = records.map((record, index) => {
    const files = record.workingTreeFiles.length ? record.workingTreeFiles.join(", ") : "нет";
    const verification = record.verifications.length
      ? record.verifications.map((item) => `${item.command} (exit ${item.exitCode})`).join("; ")
      : "не зафиксирована";
    return [
      `${index + 1}. ${record.createdAt} · ${record.kind} · ${record.id}`,
      `   project: ${record.projectId ?? "legacy record"}`,
      `   session: ${record.sessionId}`,
      `   HEAD: ${record.repositoryHead ?? "недоступен"}`,
      `   files: ${files}`,
      `   verification: ${verification}`,
      `   remote: ${record.remote ? [record.remote.dataId && `data=${record.remote.dataId}`, record.remote.entryId && `entry=${record.remote.entryId}`, record.remote.pipelineRunId && `run=${record.remote.pipelineRunId}`, record.remote.remoteContentHash && `remoteHash=${record.remote.remoteContentHash.slice(0, 12)}`, `sha256=${record.remote.contentHash.slice(0, 12)}`].filter(Boolean).join(" · ") : "not linked"}`,
      `   status: ${replacementById.has(record.id) ? `superseded by ${replacementById.get(record.id)}` : "active"}`,
      ...(record.supersedes?.length ? [`   supersedes: ${record.supersedes.join(", ")}`] : []),
      `   request: ${oneLine(record.request, 300)}`,
    ].join("\n");
  });
  return `${recall}\n\nПоследние provenance-записи:\n${entries.join("\n\n")}`;
}
