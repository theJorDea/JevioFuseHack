export type RoleName = "orchestrator" | "coder" | "architect" | "reviewer" | "judge" | "compactor";
export type SpecialistRoleName = "architect" | "coder" | "reviewer";
export type ExecutionMode = "team" | "direct" | "orchestrate" | "council-plan" | "council-review" | "plan";

/** Host-side plan mode: read-only exploration until a plan is approved. */
export interface PlanModeState {
 active: boolean;
 goal?: string;
 approvedPlan?: string;
 enteredAt?: string;
}

export interface ProviderConfig {
 baseUrl: string;
 transport?: "chat_completions" | "responses";
 toolMode?: "auto" | "native" | "text";
 defaultModel?: string;
 // apiKey takes precedence over apiKeyEnv when both are present.
 apiKey?: string;
 apiKeyEnv?: string;
 headers?: Record<string, string>;
}

export interface McpServerConfig {
 command: string;
 args: string[];
 env: Record<string, string>;
 cwd: string;
 enabled: boolean;
 roles?: RoleName[];
 startupTimeoutMs: number;
}

export interface PluginConfig {
 mcp: Record<string, McpServerConfig>;
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

export interface CogneeMemoryConfig {
 enabled: boolean;
 baseUrl: string;
 baseUrlEnv?: string;
 apiKeyEnv?: string;
 tenantIdEnv?: string;
 authMode: "x-api-key" | "bearer";
 dataset?: string;
 timeoutMs: number;
 maxResults: number;
 maxContextCharacters: number;
 maxRememberCharacters: number;
 sessionAware: boolean;
 rememberCompletedTurns: boolean;
 rememberCompactions: boolean;
}

export interface TelemetryConfig {
 enabled: boolean;
 serviceName: string;
 exporter: "console" | "otlp";
 endpoint?: string;
 endpointEnv?: string;
 sampleRatio: number;
}

export interface MemoryRecallItem {
 text: string;
 source: string;
 dataset?: string;
 datasetId?: string;
 sessionId?: string;
 score?: number;
 timestamp?: string;
}

export interface MemoryRecallSnapshot {
 query: string;
 dataset: string;
 sessionId?: string;
 recalledAt: string;
 text: string;
 items: MemoryRecallItem[];
}

export type PartialJevioConfig = {
 defaultProvider?: string;
 providers?: Record<string, Partial<ProviderConfig>>;
 roles?: Partial<Record<RoleName, Partial<RoleConfig>>>;
 agent?: Partial<JevioConfig["agent"]>;
 compaction?: Partial<JevioConfig["compaction"]>;
 codeIndex?: Partial<CodeIndexConfig>;
 memory?: { cognee?: Partial<CogneeMemoryConfig> };
 telemetry?: Partial<TelemetryConfig>;
 plugins?: { mcp?: Record<string, Partial<McpServerConfig>> };
 permissions?: Partial<JevioConfig["permissions"]>;
};

export interface JevioConfig {
 defaultProvider: string;
 providers: Record<string, ProviderConfig>;
 roles: Record<RoleName, RoleConfig>;
 agent: {
 maxTurns: number;
 maxReviewFixes: number;
 maxToolOutputCharacters: number;
 keepRecentToolResults: number;
 maxParallelReadAgents: number;
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
 memory: {
  cognee: CogneeMemoryConfig;
 };
 telemetry: TelemetryConfig;
 plugins: PluginConfig;
 permissions: {
 autoApproveWorkspaceWrites: boolean;
 autoApproveShell: boolean;
 autoApprovePlugins: boolean;
 shellMode: "off" | "tests-only" | "package-manager" | "full";
 };
}

export interface JsonSchema {
 type?: string | string[];
 description?: string;
 properties?: Record<string, JsonSchema>;
 items?: JsonSchema;
 required?: string[];
 enum?: readonly unknown[];
 additionalProperties?: boolean | JsonSchema;
 minimum?: number;
 maximum?: number;
 minItems?: number;
 maxItems?: number;
}

export interface ToolDefinition {
 type: "function";
 function: {
 name: string;
 description: string;
 parameters: JsonSchema;
 };
}

export interface PluginExecutionContext {
 confirm(message: string): Promise<boolean>;
 autoApprovePlugins: boolean;
 maxToolOutputCharacters?: number;
}

export interface PluginToolRegistry {
 listTools(role: RoleName): ToolDefinition[];
 hasTool(name: string): boolean;
 execute(name: string, input: Record<string, unknown>, context: PluginExecutionContext): Promise<string>;
 statusText(): string;
 close(): Promise<void>;
}

export interface ToolCall {
 id: string;
 name: string;
 /** Raw JSON string passed to the tool executor. */
 arguments: string;
}

export interface ProviderToolCall {
 id: string;
 type: "function";
 function: {
 name: string;
 arguments: string;
 };
}

export interface ProviderRawMessage {
 role: "assistant";
 content: string | null;
 reasoning_content?: string;
 tool_calls?: ProviderToolCall[];
 [key: string]: unknown;
}

export type ChatMessage =
 | { role: "system"; content: string }
 | { role: "user"; content: string }
 | { role: "assistant"; content: string; tool_calls?: ProviderToolCall[] }
 | { role: "tool"; content: string; tool_call_id: string; name?: string };

export interface ModelResponse {
 content: string;
 toolCalls: ToolCall[];
 rawMessage: ProviderRawMessage;
 usage?: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
 };
}

export type ModelDelta =
 | { type: "reasoning"; delta: string }
 | { type: "text"; delta: string };

export interface ModelRequest {
 messages: ChatMessage[];
 tools?: ToolDefinition[];
 temperature?: number;
 maxTokens?: number;
}

export interface ModelClient {
 complete(request: ModelRequest, onDelta?: (delta: ModelDelta) => void, signal?: AbortSignal): Promise<ModelResponse>;
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
 /** Cancellation signal for the current interactive run. */
 signal?: AbortSignal;
 skills: SkillMetadata[];
 projectMemory?: string;
 retrievedMemory?: string;
 projectCodeMap?: string;
 /** Live checklist kept in sync via update_todo. */
 todos?: TodoItem[];
 autoApproveWrites: boolean;
 autoApproveShell: boolean;
 autoApprovePlugins: boolean;
 shellMode?: "off" | "tests-only" | "package-manager" | "full";
 maxToolOutputCharacters?: number;
 codeIndex?: CodeIndexConfig;
 confirm(message: string): Promise<boolean>;
 /**
 * Ask the user structured clarifying question(s).
 * Accepts either a full form request or a legacy single question + options.
 */
 askUser?: (
 questionOrRequest: string | AskUserRequest,
 options?: AskUserOption[],
 ) => Promise<string>;
 updateTodos?: (items: TodoItem[]) => void | Promise<void>;
 reportProgress?: (message: string) => void | Promise<void>;
 recordVerification?: (record: VerificationRecord) => void;
 onWorkspaceChange?: () => void;
 delegate?: (role: SpecialistRoleName, task: string) => Promise<string>;
 /**
 * Ask host to switch execution mode.
 * Return true if accepted. Host may restart the current task when applyNow is true.
 */
 suggestMode?: (
 mode: ExecutionMode,
 reason: string,
 options?: { applyNow?: boolean },
 ) => Promise<boolean>;
 /** Live plan-mode flag; mutations are blocked while active. */
 planMode?: PlanModeState;
 enterPlanMode?: (goal?: string) => Promise<string>;
 exitPlanMode?: (reason?: string) => Promise<string>;
 submitPlan?: (plan: string) => Promise<string>;
 plugins?: PluginToolRegistry;
}

export interface VerificationRecord {
 command: string;
 exitCode: number | string;
 summary: string;
}

export interface AskUserOption {
 label: string;
 description?: string;
}

/** One question in a structured ask-user form. */
export interface AskUserQuestion {
 /** Stable id for multi-question answers (optional; defaults to q1, q2…). */
 id?: string;
 /** The question prompt shown to the user. */
 question: string;
 /** Optional multiple-choice options. Empty → free text. */
 options?: AskUserOption[];
 /** Allow selecting several options (default false). */
 multiSelect?: boolean;
 /** Show "Другое..." free-text (default true when options exist). */
 allowOther?: boolean;
}

/** Batch of clarifying questions — agent pauses until the user answers. */
export interface AskUserRequest {
 /** Optional short header (why we're asking). */
 header?: string;
 questions: AskUserQuestion[];
}

export interface TodoItem {
 content: string;
 status: "pending" | "in_progress" | "completed";
}

export interface AgentResult {
 content: string;
 turns: number;
 delegatedRoles?: SpecialistRoleName[];
}
