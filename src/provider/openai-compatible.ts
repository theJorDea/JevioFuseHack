import type {
  ChatMessage,
  ModelClient,
  ModelDelta,
  ModelRequest,
  ModelResponse,
  ProviderConfig,
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

  async complete(request: ModelRequest, onDelta?: (delta: ModelDelta) => void): Promise<ModelResponse> {
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
        stream: Boolean(onDelta),
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });

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
    return streamResponse(response.body, onDelta);
  }
}

function modelResponse(message: OpenAIMessage): ModelResponse {
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    })).filter((call) => call.name);
  const rawMessage: ChatMessage = {
    role: "assistant",
    content: message.content ?? "",
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
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
