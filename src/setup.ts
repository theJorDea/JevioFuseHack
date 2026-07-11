export interface LocalProviderCandidate {
  name: "ollama" | "lmstudio";
  label: string;
  baseUrl: string;
  models: string[];
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "json">>;

function stringsFrom(value: unknown, key: "name" | "id"): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = (item as Record<string, unknown>)[key];
    return typeof candidate === "string" && candidate.trim() ? [candidate.trim()] : [];
  }))];
}

async function probe(
  fetcher: Fetcher,
  url: string,
  selectModels: (payload: unknown) => string[],
): Promise<string[] | null> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return null;
    return selectModels(await response.json());
  } catch {
    return null;
  }
}

export async function discoverLocalProviders(fetcher: Fetcher = fetch): Promise<LocalProviderCandidate[]> {
  const [ollamaModels, lmStudioModels] = await Promise.all([
    probe(fetcher, "http://localhost:11434/api/tags", (payload) => stringsFrom((payload as { models?: unknown })?.models, "name")),
    probe(fetcher, "http://localhost:1234/v1/models", (payload) => stringsFrom((payload as { data?: unknown })?.data, "id")),
  ]);
  return [
    ...(ollamaModels === null ? [] : [{ name: "ollama" as const, label: "Ollama", baseUrl: "http://localhost:11434/v1", models: ollamaModels }]),
    ...(lmStudioModels === null ? [] : [{ name: "lmstudio" as const, label: "LM Studio", baseUrl: "http://localhost:1234/v1", models: lmStudioModels }]),
  ];
}

/** Extract model ids from OpenAI-compatible /models JSON (and a few common variants). */
export function parseModelsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const fromData = stringsFrom(root.data, "id");
  if (fromData.length) return fromData;
  const fromModelsName = stringsFrom(root.models, "name");
  if (fromModelsName.length) return fromModelsName;
  const fromModelsId = stringsFrom(root.models, "id");
  if (fromModelsId.length) return fromModelsId;
  if (Array.isArray(root)) {
    return [...new Set(root.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [item.trim()];
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        for (const key of ["id", "name", "model"]) {
          if (typeof record[key] === "string" && record[key].trim()) return [record[key].trim()];
        }
      }
      return [];
    }))];
  }
  return [];
}

/**
 * List models from any OpenAI-compatible provider via GET {baseUrl}/models.
 * Works for Ollama (/v1), LM Studio, OpenRouter, custom gateways, etc.
 */
export async function listProviderModels(
  baseUrl: string,
  options: {
    apiKey?: string;
    timeoutMs?: number;
    fetcher?: Fetcher;
  } = {},
): Promise<string[]> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const response = await fetcher(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const status = "status" in response ? String((response as { status?: number }).status ?? "error") : "error";
    throw new Error(`Models endpoint returned HTTP ${status} for ${url}`);
  }
  const models = parseModelsPayload(await response.json());
  return models.sort((a, b) => a.localeCompare(b));
}

export function defaultModel(models: string[]): string | undefined {
  return models.find((model) => /(?:coder|code|devstral|deepseek)/i.test(model)) ?? models[0];
}

export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}
