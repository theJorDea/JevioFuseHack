import type { CogneeMemoryConfig, MemoryRecallItem, MemoryRecallSnapshot } from "./types.ts";
import type { MemoryProvenanceRecord } from "./memory-journal.ts";
import { legacyProjectDataset } from "./project-identity.ts";

type Fetcher = typeof fetch;

class CogneeHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Cognee HTTP ${status}${responseBody ? `: ${responseBody.slice(0, 300)}` : ""}`);
    this.status = status;
    this.responseBody = responseBody;
  }
}

export interface MemoryStatus {
  enabled: boolean;
  available: boolean;
  detail: string;
  dataset: string;
  pipelineStatus?: string;
}

function optionalString(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
  }
  return undefined;
}

function responseItems(value: unknown, defaults: Pick<MemoryRecallItem, "source"> & Partial<MemoryRecallItem>): MemoryRecallItem[] {
  if (typeof value === "string") return value.trim() ? [{ text: value.trim(), ...defaults }] : [];
  if (Array.isArray(value)) return value.flatMap((item) => responseItems(item, defaults));
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const text = optionalString(item, ["text", "content", "context", "summary", "answer", "search_result"]);
  if (text) {
    const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : undefined;
    return [{
      text,
      source: optionalString(item, ["source", "_source"]) ?? defaults.source,
      dataset: optionalString(item, ["dataset_name", "datasetName", "dataset"]) ?? defaults.dataset,
      datasetId: optionalString(item, ["dataset_id", "datasetId"]) ?? defaults.datasetId,
      sessionId: optionalString(item, ["session_id", "sessionId"]) ?? defaults.sessionId,
      ...(score !== undefined ? { score } : defaults.score !== undefined ? { score: defaults.score } : {}),
      timestamp: optionalString(item, ["time", "timestamp", "created_at", "createdAt"]) ?? defaults.timestamp,
    }];
  }
  for (const key of ["results", "data", "items", "chunks", "raw", "structured"]) {
    if (item[key] !== undefined) return responseItems(item[key], defaults);
  }
  return [];
}

function datasetRecords(value: unknown): Array<{ id: string; name: string }> {
  const records: Array<{ id: string; name: string }> = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    const item = current as Record<string, unknown>;
    const id = item.id ?? item.dataset_id ?? item.datasetId;
    const name = item.name ?? item.dataset_name ?? item.datasetName;
    if (typeof id === "string" && typeof name === "string") records.push({ id, name });
    for (const key of ["data", "datasets", "items", "results"]) {
      if (item[key] !== undefined) visit(item[key]);
    }
  };
  visit(value);
  return records;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CogneeMemory {
  readonly dataset: string;
  private readonly baseUrl: string;
  private readonly config: CogneeMemoryConfig;
  private readonly fetcher: Fetcher;
  private latestRecall?: MemoryRecallSnapshot;

  constructor(
    config: CogneeMemoryConfig,
    workspace: string,
    fetcher: Fetcher = fetch,
  ) {
    this.config = config;
    this.fetcher = fetcher;
    const environmentBaseUrl = config.baseUrlEnv ? process.env[config.baseUrlEnv]?.trim() : undefined;
    this.baseUrl = (environmentBaseUrl || config.baseUrl).replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
    this.dataset = config.dataset?.trim() || legacyProjectDataset(workspace);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get lastRecall(): MemoryRecallSnapshot | undefined {
    return this.latestRecall ? structuredClone(this.latestRecall) : undefined;
  }

  private headers(json = false): Headers {
    const headers = new Headers(json ? { "content-type": "application/json" } : undefined);
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (key) {
      headers.set(this.config.authMode === "bearer" ? "authorization" : "x-api-key", this.config.authMode === "bearer" ? `Bearer ${key}` : key);
    }
    return headers;
  }

  private configurationIssue(): string | undefined {
    if (this.config.baseUrlEnv && !process.env[this.config.baseUrlEnv]?.trim()) return `missing ${this.config.baseUrlEnv}`;
    if (this.config.apiKeyEnv && !process.env[this.config.apiKeyEnv]) return `missing ${this.config.apiKeyEnv}`;
    return undefined;
  }

  private async request(route: string, init: RequestInit = {}): Promise<unknown> {
    const issue = this.configurationIssue();
    if (issue) throw new Error(issue);
    const response = await this.fetcher(`${this.baseUrl}${route}`, {
      ...init,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new CogneeHttpError(response.status, text);
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async status(): Promise<MemoryStatus> {
    if (!this.enabled) return { enabled: false, available: false, detail: "disabled", dataset: this.dataset };
    const issue = this.configurationIssue();
    if (issue) return { enabled: true, available: false, detail: issue, dataset: this.dataset };
    try {
      await this.request("/health", { headers: this.headers() });
      try {
        const datasets = datasetRecords(await this.request("/api/v1/datasets", { headers: this.headers() }));
        const dataset = datasets.find((item) => item.name === this.dataset);
        if (!dataset) {
          return { enabled: true, available: true, detail: `${this.baseUrl}; dataset not created yet`, dataset: this.dataset };
        }
        const state = await this.request(`/api/v1/datasets/status?dataset=${encodeURIComponent(dataset.id)}`, { headers: this.headers() });
        const pipelineStatus = state && typeof state === "object" && typeof (state as Record<string, unknown>)[dataset.id] === "string"
          ? String((state as Record<string, unknown>)[dataset.id])
          : undefined;
        return { enabled: true, available: true, detail: this.baseUrl, dataset: this.dataset, pipelineStatus };
      } catch {
        return { enabled: true, available: true, detail: this.baseUrl, dataset: this.dataset };
      }
    } catch (error) {
      return { enabled: true, available: false, detail: (error as Error).message, dataset: this.dataset };
    }
  }

  async recall(query: string, sessionId?: string): Promise<string> {
    const normalizedQuery = query.trim();
    this.latestRecall = undefined;
    if (!this.enabled || !normalizedQuery) return "";
    this.latestRecall = {
      query: normalizedQuery,
      dataset: this.dataset,
      ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}),
      recalledAt: new Date().toISOString(),
      text: "",
      items: [],
    };
    const items: MemoryRecallItem[] = [];
    if (this.config.sessionAware && sessionId?.trim()) {
      try {
        const response = await this.request("/api/v1/recall", {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({
            query: normalizedQuery,
            top_k: Math.floor(this.config.maxResults),
            only_context: true,
            scope: "session",
            session_id: sessionId.trim(),
          }),
        });
        items.push(...responseItems(response, { source: "session", sessionId: sessionId.trim() }));
      } catch {
        // Session memory is an optional fast path. Graph recall remains authoritative.
      }
    }
    let response: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await this.request("/api/v1/recall", {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({
            query: normalizedQuery,
            top_k: Math.floor(this.config.maxResults),
            only_context: true,
            scope: "auto",
            datasets: [this.dataset],
            ...(sessionId ? { session_id: sessionId } : {}),
          }),
        });
        break;
      } catch (error) {
        const missingDataset = error instanceof CogneeHttpError
          && error.status === 404
          && /DatasetNotFound|No datasets found|prerequisites not met/i.test(error.responseBody);
        const creationRace = error instanceof CogneeHttpError
          && error.status === 500
          && /UniqueViolationError|already exists/i.test(error.responseBody);
        const legacyServer = error instanceof CogneeHttpError
          && error.status === 404
          && !missingDataset;
        if (missingDataset) {
          response = undefined;
          break;
        }
        if (legacyServer) {
          response = await this.request("/api/v1/search", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
              query: normalizedQuery,
              search_type: "CHUNKS",
              datasets: [this.dataset],
              ...(sessionId ? { session_id: sessionId } : {}),
            }),
          });
          break;
        }
        if (creationRace && attempt < 3) {
          await delay(500 * (2 ** attempt));
          continue;
        }
        throw error;
      }
    }
    items.push(...responseItems(response, {
      source: "graph",
      dataset: this.dataset,
      ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}),
    }));
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      if (seen.has(item.text)) return false;
      seen.add(item.text);
      return true;
    }).slice(0, Math.floor(this.config.maxResults));
    const text = unique.map((item) => item.text).join("\n\n---\n\n")
      .slice(0, Math.floor(this.config.maxContextCharacters));
    this.latestRecall.text = text;
    this.latestRecall.items = unique;
    return text;
  }

  async remember(content: string, sessionId?: string, filename = "memory.md"): Promise<void> {
    if (!this.enabled || !content.trim()) return;
    const boundedContent = content.trim().slice(0, Math.floor(this.config.maxRememberCharacters));
    const normalizedSessionId = this.config.sessionAware ? sessionId?.trim() : undefined;
    if (normalizedSessionId) {
      await this.request("/api/v1/remember/entry", {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          entry: {
            type: "qa",
            question: `Jevio memory entry: ${filename}`,
            answer: boundedContent,
            context: "",
            used_graph_element_ids: {},
          },
          dataset_name: this.dataset,
          session_id: normalizedSessionId,
        }),
      });
      return;
    }

    const form = new FormData();
    form.append("data", new Blob([boundedContent], { type: "text/markdown" }), filename);
    form.append("datasetName", this.dataset);
    form.append("run_in_background", "true");
    await this.request("/api/v1/remember", { method: "POST", headers: this.headers(), body: form });
  }

  async improve(sessionIds: string[] = []): Promise<void> {
    if (!this.enabled) return;
    const body = JSON.stringify({
      datasetName: this.dataset,
      runInBackground: true,
      sessionIds: [...new Set(sessionIds.map((item) => item.trim()).filter(Boolean))],
    });
    try {
      await this.request("/api/v1/improve", { method: "POST", headers: this.headers(true), body });
    } catch (error) {
      if (!(error instanceof CogneeHttpError) || error.status !== 404) throw error;
      await this.request("/api/v1/memify", { method: "POST", headers: this.headers(true), body });
    }
  }

  async forget(): Promise<boolean> {
    if (!this.enabled) return false;
    const response = await this.request("/api/v1/datasets", { headers: this.headers() });
    const dataset = datasetRecords(response).find((item) => item.name === this.dataset);
    if (!dataset) return false;
    await this.request(`/api/v1/datasets/${encodeURIComponent(dataset.id)}`, { method: "DELETE", headers: this.headers() });
    return true;
  }
}

function inlineMetadata(value: string): string {
  return value.replace(/[\r\n`]+/g, " ").trim();
}

export function completedTurnMemory(task: string, answer: string, provenance?: MemoryProvenanceRecord): string {
  const metadata = provenance ? [
    "## Provenance",
    "",
    `- Record: \`${inlineMetadata(provenance.id)}\``,
    `- Created: \`${inlineMetadata(provenance.createdAt)}\``,
    `- Project: ${provenance.projectId ? `\`${inlineMetadata(provenance.projectId)}\`` : "legacy record"}`,
    `- Session: \`${inlineMetadata(provenance.sessionId)}\``,
    `- Repository HEAD: ${provenance.repositoryHead ? `\`${inlineMetadata(provenance.repositoryHead)}\`` : "unavailable"}`,
    `- Working tree files: ${provenance.workingTreeFiles.length ? provenance.workingTreeFiles.map((file) => `\`${inlineMetadata(file)}\``).join(", ") : "none"}`,
    `- Verification: ${provenance.verifications.length ? provenance.verifications.map((item) => `\`${inlineMetadata(item.command)}\` (exit ${item.exitCode})`).join("; ") : "not recorded"}`,
    "",
  ].join("\n") : "";
  return `# Completed Jevio task\n\n${metadata}## User request\n\n${task.trim()}\n\n## Result\n\n${answer.trim()}`;
}
