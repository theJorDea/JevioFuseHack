import type {
  ModelClient,
  ModelDelta,
  ModelRequest,
  ModelResponse,
  ProviderConfig,
  ProviderRawMessage,
  RoleConfig,
  ToolCall,
} from "../types.ts";

interface OpenAIChoice {
  message?: OpenAIMessage;
  delta?: OpenAIMessage & { tool_calls?: Array<OpenAIToolCall & { index?: number }> };
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

interface BufferedToolCall {
  id?: string;
  name: string;
  arguments: string;
}

interface ResponsesOutput {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesResponse {
  output?: ResponsesOutput[];
  output_text?: string;
  error?: { message?: string };
}

function appendToolName(current: string, fragment: string): string {
  if (!current || fragment.startsWith(current)) return fragment;
  if (current.endsWith(fragment)) return current;
  return current + fragment;
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

  async complete(request: ModelRequest, onDelta?: (delta: ModelDelta) => void, signal?: AbortSignal): Promise<ModelResponse> {
    if (this.#provider.transport === "responses") return this.completeResponses(request, onDelta, signal);
    const apiKey = this.#provider.apiKey
      ?? (this.#provider.apiKeyEnv ? process.env[this.#provider.apiKeyEnv] : undefined);
    if (this.#provider.apiKeyEnv && !apiKey) {
      throw new Error(`Environment variable ${this.#provider.apiKeyEnv} is not set.`);
    }

    let response: Response;
    try {
      response = await fetch(`${this.#provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
          stream: Boolean(onDelta),
        }),
        signal: requestSignal(signal),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (onDelta) return this.complete(request, undefined, signal);
      throw new Error(`Unable to reach model endpoint ${this.#provider.baseUrl}: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      let body: OpenAIResponse = {};
      try { body = JSON.parse(text) as OpenAIResponse; } catch {}
      throw new Error(body.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    }

    if (!onDelta || response.headers.get("content-type")?.includes("application/json")) {
      const text = await response.text();
      let body: OpenAIResponse;
      try {
        body = JSON.parse(text) as OpenAIResponse;
      } catch {
        throw new Error(`Model endpoint returned invalid JSON (${response.status}): ${text.slice(0, 500)}`);
      }
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("Model endpoint returned no assistant message.");
      if (message.reasoning_content) onDelta?.({ type: "reasoning", delta: message.reasoning_content });
      return modelResponse(message);
    }

    if (!response.body) throw new Error("Model endpoint returned an empty streaming response.");
    try {
      return await streamResponse(response.body, onDelta);
    } catch (error) {
      if (isTransientStreamError(error) && !signal?.aborted) return this.complete(request, undefined, signal);
      throw error;
    }
  }

  private async completeResponses(request: ModelRequest, onDelta?: (delta: ModelDelta) => void, signal?: AbortSignal): Promise<ModelResponse> {
    const apiKey = this.#provider.apiKey
      ?? (this.#provider.apiKeyEnv ? process.env[this.#provider.apiKeyEnv] : undefined);
    if (this.#provider.apiKeyEnv && !apiKey) {
      throw new Error(`Environment variable ${this.#provider.apiKeyEnv} is not set.`);
    }
    const instructions = request.messages.filter((message) => message.role === "system")
      .map((message) => message.content).join("\n\n");
    const input = request.messages.flatMap((message) => {
      if (message.role === "system") return [];
      if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
      if (message.role === "assistant") {
        return [
          ...(message.content ? [{ role: "assistant", content: message.content }] : []),
          ...(message.tool_calls ?? []).map((call) => ({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        ];
      }
      return [{ role: message.role, content: message.content }];
    });
    const response = await fetch(`${this.#provider.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.#provider.headers,
      },
      body: JSON.stringify({
        model: this.#role.model,
        ...(instructions ? { instructions } : {}),
        input,
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })),
        } : {}),
        ...(request.maxTokens ?? this.#role.maxTokens ? { max_output_tokens: request.maxTokens ?? this.#role.maxTokens } : {}),
      }),
      signal: requestSignal(signal),
    });
    const text = await response.text();
    let body: ResponsesResponse;
    try {
      body = JSON.parse(text) as ResponsesResponse;
    } catch {
      throw new Error(`Responses endpoint returned invalid JSON (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok) throw new Error(body.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    const content = body.output_text ?? body.output?.flatMap((item) => item.type === "message"
      ? (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "")
      : []).join("") ?? "";
    const calls = (body.output ?? []).filter((item) => item.type === "function_call" && item.name).map((item, index) => ({
      id: item.call_id ?? `call_${index}`,
      function: { name: item.name!, arguments: item.arguments ?? "{}" },
    }));
    if (content) onDelta?.({ type: "text", delta: content });
    return modelResponse({ content, ...(calls.length ? { tool_calls: calls } : {}) });
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10 * 60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientStreamError(error: unknown): boolean {
  return /terminated|fetch failed|socket|econnreset|premature|closed/i.test(errorMessage(error));
}

function modelResponse(message: OpenAIMessage): ModelResponse {
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "{}",
  })).filter((call) => call.name);
  const providerToolCalls = toolCalls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
  const rawMessage: ProviderRawMessage = {
    role: "assistant",
    content: message.content ?? "",
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(providerToolCalls.length ? { tool_calls: providerToolCalls } : {}),
  };
  return { content: message.content ?? "", toolCalls, rawMessage };
}

async function streamResponse(body: ReadableStream<Uint8Array>, onDelta: (delta: ModelDelta) => void): Promise<ModelResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const toolCalls = new Map<number, BufferedToolCall>();
  let buffer = "";
  let content = "";
  let reasoning = "";

  const consume = (payload: string): void => {
    if (!payload || payload === "[DONE]") return;
    let chunk: OpenAIResponse;
    try { chunk = JSON.parse(payload) as OpenAIResponse; } catch { return; }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onDelta({ type: "reasoning", delta: delta.reasoning_content });
    }
    if (delta.content) {
      content += delta.content;
      onDelta({ type: "text", delta: delta.content });
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? toolCalls.size;
      const current = toolCalls.get(index) ?? { name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name = appendToolName(current.name, call.function.name);
      if (call.function?.arguments) current.arguments += call.function.arguments;
      toolCalls.set(index, current);
    }
  };

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const payload = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      consume(payload);
    }
  }

  buffer += decoder.decode();
  const trailing = buffer.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  consume(trailing);
  const calls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call], index) => ({
    id: call.id ?? `call_${index}`,
    function: { name: call.name, arguments: call.arguments || "{}" },
  })).filter((call) => call.function.name);
  return modelResponse({ content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
}
