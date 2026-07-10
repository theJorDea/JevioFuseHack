import { createHash } from "node:crypto";
import path from "node:path";
import type { CogneeMemoryConfig } from "./types.ts";

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
}

function projectDataset(workspace: string, configured?: string): string {
  if (configured?.trim()) return configured.trim();
  const name = path.basename(path.resolve(workspace)).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "project";
  const hash = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12);
  return `jevio-${name.slice(0, 40)}-${hash}`;
}

function responseStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(responseStrings);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  for (const key of ["text", "content", "summary", "answer"]) {
    if (typeof item[key] === "string" && item[key].trim()) return [item[key].trim()];
  }
  for (const key of ["results", "data", "items", "chunks"]) {
    if (item[key] !== undefined) return responseStrings(item[key]);
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

  constructor(
    config: CogneeMemoryConfig,
    workspace: string,
    fetcher: Fetcher = fetch,
  ) {
    this.config = config;
    this.fetcher = fetcher;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
    this.dataset = projectDataset(workspace, config.dataset);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private headers(json = false): Headers {
    const headers = new Headers(json ? { "content-type": "application/json" } : undefined);
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (key) {
      headers.set(this.config.authMode === "bearer" ? "authorization" : "x-api-key", this.config.authMode === "bearer" ? `Bearer ${key}` : key);
    }
    return headers;
  }

  private async request(route: string, init: RequestInit = {}): Promise<unknown> {
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
    if (this.config.apiKeyEnv && !process.env[this.config.apiKeyEnv]) {
      return { enabled: true, available: false, detail: `missing ${this.config.apiKeyEnv}`, dataset: this.dataset };
    }
    try {
      await this.request("/health", { headers: this.headers() });
      return { enabled: true, available: true, detail: this.baseUrl, dataset: this.dataset };
    } catch (error) {
      return { enabled: true, available: false, detail: (error as Error).message, dataset: this.dataset };
    }
  }

  async recall(query: string, sessionId?: string): Promise<string> {
    if (!this.enabled || !query.trim()) return "";
    let response: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await this.request("/api/v1/recall", {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({
            query: query.trim(),
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
        if (missingDataset) return "";
        if (legacyServer) {
          response = await this.request("/api/v1/search", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
              query: query.trim(),
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
    const unique = [...new Set(responseStrings(response))].slice(0, Math.floor(this.config.maxResults));
    return unique.join("\n\n---\n\n").slice(0, Math.floor(this.config.maxContextCharacters));
  }

  async remember(content: string, _sessionId?: string, filename = "memory.md"): Promise<void> {
    if (!this.enabled || !content.trim()) return;
    const form = new FormData();
    form.append("data", new Blob([content.trim().slice(0, Math.floor(this.config.maxRememberCharacters))], { type: "text/markdown" }), filename);
    form.append("datasetName", this.dataset);
    form.append("run_in_background", "true");
    await this.request("/api/v1/remember", { method: "POST", headers: this.headers(), body: form });
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

export function completedTurnMemory(task: string, answer: string): string {
  return `# Completed Jevio task\n\n## User request\n\n${task.trim()}\n\n## Result\n\n${answer.trim()}`;
}
