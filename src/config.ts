import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodeIndexConfig, JevioConfig, PartialJevioConfig, ProviderConfig, RoleConfig, RoleName } from "./types.ts";

const DEFAULT_CONFIG: JevioConfig = {
  defaultProvider: "ollama",
  providers: {
    ollama: { baseUrl: "http://localhost:11434/v1" },
  },
  roles: {
    orchestrator: { model: "qwen3:14b", temperature: 0.15 },
    coder: { model: "qwen3-coder:30b", temperature: 0.15 },
    architect: { model: "qwen3:14b", temperature: 0.2 },
    reviewer: { model: "qwen3:14b", temperature: 0.1 },
    judge: { model: "qwen3:14b", temperature: 0.1 },
    compactor: { model: "qwen3:14b", temperature: 0.1 },
  },
  agent: {
    maxTurns: 24,
    maxReviewFixes: 1,
    maxToolOutputCharacters: 12_000,
    keepRecentToolResults: 6,
  },
  compaction: {
    auto: true,
    contextWindowTokens: 32_768,
    reservedTokens: 4_096,
    triggerCharacters: 80_000,
    keepRecentMessages: 6,
    maxSummaryCharacters: 16_000,
    prompt: "Preserve user requirements, decisions, relevant files, completed changes, verification results, unresolved errors, and exact next steps. Remove repetition and conversational filler.",
  },
  codeIndex: {
    enabled: true,
    backend: "auto",
    prewarm: true,
    maxFiles: 10_000,
    cacheTtlMs: 5_000,
    maxResults: 20,
    mapMaxCharacters: 12_000,
  },
  permissions: {
    autoApproveWorkspaceWrites: false,
    autoApproveShell: false,
  },
};

function expandEnvironment(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(expandEnvironment);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEnvironment(item)]),
    );
  }
  return value;
}

function validateRoleConfig(role: RoleName, config: RoleConfig): void {
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) {
    throw new Error(`Invalid temperature for role '${role}': expected a number between 0 and 2.`);
  }
  if (config.maxTokens !== undefined && (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error(`Invalid maxTokens for role '${role}': expected a positive number.`);
  }
}

function mergeConfig(input: PartialJevioConfig): JevioConfig {
  const roles = {} as Record<RoleName, RoleConfig>;
  for (const role of ["orchestrator", "coder", "architect", "reviewer", "judge", "compactor"] as RoleName[]) {
    roles[role] = { ...DEFAULT_CONFIG.roles[role], ...input.roles?.[role] };
    validateRoleConfig(role, roles[role]);
  }
  return {
    defaultProvider: input.defaultProvider ?? DEFAULT_CONFIG.defaultProvider,
    providers: { ...DEFAULT_CONFIG.providers, ...input.providers } as Record<string, ProviderConfig>,
    roles,
    agent: { ...DEFAULT_CONFIG.agent, ...input.agent },
    compaction: { ...DEFAULT_CONFIG.compaction, ...input.compaction },
    codeIndex: { ...DEFAULT_CONFIG.codeIndex, ...input.codeIndex } as CodeIndexConfig,
    permissions: { ...DEFAULT_CONFIG.permissions, ...input.permissions },
  };
}

export async function findConfig(start: string): Promise<string | null> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, "jevio.config.json");
    try {
      await access(candidate);
      return candidate;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadConfig(workspace: string, explicitPath?: string): Promise<JevioConfig> {
  const configPath = explicitPath ? path.resolve(explicitPath) : await findConfig(workspace);
  const config = configPath
    ? mergeConfig(expandEnvironment(JSON.parse(await readFile(configPath, "utf8")) as PartialJevioConfig) as PartialJevioConfig)
    : structuredClone(DEFAULT_CONFIG);
  try {
    const secrets = JSON.parse(await readFile(path.join(workspace, ".jevio", "providers.json"), "utf8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    for (const [name, secret] of Object.entries(secrets.providers ?? {})) {
      if (config.providers[name] && secret.apiKey) config.providers[name].apiKey = secret.apiKey;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return config;
}

export async function saveProviderSecret(workspace: string, name: string, apiKey: string): Promise<string> {
  const directory = path.join(workspace, ".jevio");
  const target = path.join(directory, "providers.json");
  let secrets: { providers: Record<string, { apiKey?: string }> } = { providers: {} };
  try {
    secrets = JSON.parse(await readFile(target, "utf8")) as typeof secrets;
    if (!secrets.providers || typeof secrets.providers !== "object") secrets.providers = {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  secrets.providers[name] = { apiKey };
  await mkdir(directory, { recursive: true });
  await writeFile(target, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
  return target;
}

export async function addProviderConfig(
  workspace: string,
  explicitPath: string | undefined,
  provider: { name: string; baseUrl: string; apiKeyEnv?: string; model: string },
): Promise<string> {
  const name = provider.name.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error("Provider name must start with a letter and use only letters, numbers, _ or -.");
  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl.trim());
  } catch {
    throw new Error("Base URL must be an absolute http(s) URL.");
  }
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("Base URL must use http or https.");
  const apiKeyEnv = provider.apiKeyEnv?.trim();
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("Enter an environment variable name, for example OPENAI_API_KEY, not the API key itself.");
  }
  const model = provider.model.trim();
  if (!model) throw new Error("Model name is required.");

  const target = explicitPath ? path.resolve(explicitPath) : (await findConfig(workspace)) ?? path.join(workspace, "jevio.config.json");
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const providers = input.providers && typeof input.providers === "object" && !Array.isArray(input.providers)
    ? input.providers as Record<string, unknown>
    : {};
  providers[name] = {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
  input.providers = providers;
  const roles = input.roles && typeof input.roles === "object" && !Array.isArray(input.roles)
    ? input.roles as Record<string, Record<string, unknown>>
    : {};
  for (const role of ["orchestrator", "coder", "architect", "reviewer", "judge", "compactor"]) {
    roles[role] = {
      ...roles[role],
      provider: name,
      model,
      ...( /\bkimi\b/i.test(model) ? { temperature: 1 } : {}),
    };
  }
  input.roles = roles;
  input.defaultProvider = name;
  await writeFile(target, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return target;
}

export function resolveProvider(config: JevioConfig, role: RoleName): ProviderConfig & RoleConfig {
  const roleConfig = config.roles[role];
  const providerName = roleConfig.provider ?? config.defaultProvider;
  const provider = config.providers[providerName];
  if (!provider) throw new Error(`Unknown provider '${providerName}' configured for role '${role}'.`);
  return { ...provider, ...roleConfig };
}

export { DEFAULT_CONFIG };
