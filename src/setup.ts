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

export function defaultModel(models: string[]): string | undefined {
  return models.find((model) => /(?:coder|code|devstral|deepseek)/i.test(model)) ?? models[0];
}

export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}
