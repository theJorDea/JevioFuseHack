export type RoleName = "orchestrator" | "coder" | "architect" | "reviewer" | "compactor";

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export interface RoleConfig {
  provider?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CodeIndexConfig {
  enabled: boolean;
  backend: "auto" | "ctags" | "builtin";
  prewarm: boolean;
  maxFiles: number;
  cacheTtlMs: number;
  maxResults: number;
  mapMaxCharacters: number;
}

export interface JevioConfig {
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  roles: Record<RoleName, RoleConfig>;
  agent: {
    maxTurns: number;
    maxReviewFixes: number;
    maxToolOutputCharacters: number;
    keepRecentToolResults: number;
  };
  compaction: {
    auto: boolean;
    contextWindowTokens: number;
    reservedTokens: number;
    triggerCharacters: number;
    keepRecentMessages: number;
    maxSummaryCharacters: number;
    prompt: string;
  };
  codeIndex: CodeIndexConfig;
  permissions: {
    autoApproveWorkspaceWrites: boolean;
    autoApproveShell: boolean;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage = Record<string, unknown> & {
  role: "system" | "user" | "assistant" | "tool";
};

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  rawMessage: ChatMessage;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable: boolean;
  path: string;
}

export interface ToolContext {
  workspace: string;
  skills: SkillMetadata[];
  projectMemory?: string;
  projectCodeMap?: string;
  autoApproveWrites: boolean;
  autoApproveShell: boolean;
  maxToolOutputCharacters?: number;
  codeIndex?: CodeIndexConfig;
  confirm(message: string): Promise<boolean>;
  delegate?: (role: Exclude<RoleName, "orchestrator">, task: string) => Promise<string>;
}

export interface AgentResult {
  content: string;
  turns: number;
}
