import type {
  ChatMessage,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ProviderConfig,
  RoleConfig,
  ToolCall,
} from "../types.ts";

interface OpenAIChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

export function effectiveTemperature(role: RoleConfig, requested?: number): number {
  // Moonshot's Kimi K2.7 API currently accepts only temperature 1.
  if (/\bkimi\b/i.test(role.model)) return 1;
  return requested ?? role.temperature ?? 0.2;
}

export class OpenAICompatibleClient implements ModelClient {
  readonly #provider: ProviderConfig;
  readonly #role: RoleConfig;

  constructor(provider: ProviderConfig, role: RoleConfig) {
    this.#provider = provider;
    this.#role = role;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.#provider.apiKey
      ?? (this.#provider.apiKeyEnv ? process.env[this.#provider.apiKeyEnv] : undefined);
    if (this.#provider.apiKeyEnv && !apiKey) {
      throw new Error(`Environment variable ${this.#provider.apiKeyEnv} is not set.`);
    }

    const response = await fetch(`${this.#provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.#provider.headers,
      },
      body: JSON.stringify({
        model: this.#role.model,
        messages: request.messages,
        tools: request.tools?.length ? request.tools : undefined,
        tool_choice: request.tools?.length ? "auto" : undefined,
        temperature: effectiveTemperature(this.#role, request.temperature),
        max_tokens: request.maxTokens ?? this.#role.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });

    const text = await response.text();
    let body: OpenAIResponse;
    try {
      body = JSON.parse(text) as OpenAIResponse;
    } catch {
      throw new Error(`Model endpoint returned invalid JSON (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(body.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    }

    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("Model endpoint returned no assistant message.");
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    })).filter((call) => call.name);
    const rawMessage: ChatMessage = {
      role: "assistant",
      content: message.content ?? "",
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
    return { content: message.content ?? "", toolCalls, rawMessage };
  }
}
