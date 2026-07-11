import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type {
  JsonSchema,
  JevioConfig,
  McpServerConfig,
  PluginExecutionContext,
  PluginToolRegistry,
  RoleName,
  ToolDefinition,
} from "./types.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MCP_CLIENT_VERSION = "0.1.0";
const DEFAULT_OUTPUT_LIMIT = 100_000;

type JsonObject = Record<string, unknown>;

interface RpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpToolDescription {
  name?: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; [key: string]: unknown };
}

interface ToolBinding {
  exposedName: string;
  serverName: string;
  remoteName: string;
  connection: McpStdioConnection;
  definition: ToolDefinition;
  roles?: RoleName[];
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(value: string, limit = DEFAULT_OUTPUT_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[MCP output truncated: ${value.length - limit} characters omitted]`;
}

function normalizeInputSchema(schema: unknown): JsonSchema {
  if (isObject(schema) && (schema.type === undefined || typeof schema.type === "string")) {
    return schema as JsonSchema;
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

function safeToolPart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function resolvePluginCwd(workspace: string, cwd: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(root, cwd || ".");
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`MCP cwd escapes the workspace: ${cwd}`);
  }
  return target;
}

class McpStdioConnection {
  private readonly workspace: string;
  private readonly serverName: string;
  private readonly config: McpServerConfig;
  private child?: ChildProcessWithoutNullStreams;
  private exitPromise?: Promise<void>;
  private buffer = "";
  private nextId = 1;
  private closing = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    workspace: string,
    serverName: string,
    config: McpServerConfig,
  ) {
    this.workspace = workspace;
    this.serverName = serverName;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const cwd = resolvePluginCwd(this.workspace, this.config.cwd);
    const child = spawn(this.config.command, this.config.args, {
      cwd,
      env: { ...process.env, ...this.config.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.on("error", (error) => this.failPending(new Error(`MCP server '${this.serverName}' failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (this.closing) return;
      this.failPending(new Error(`MCP server '${this.serverName}' exited (${signal ?? code ?? "unknown"}).`));
    });

    const initialized = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jevio", version: MCP_CLIENT_VERSION },
    });
    const protocolVersion = isObject(initialized) ? initialized.protocolVersion : undefined;
    if (typeof protocolVersion !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
      throw new Error(`MCP server '${this.serverName}' returned unsupported protocol version '${String(protocolVersion)}'.`);
    }
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDescription[]> {
    const tools: McpToolDescription[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : undefined);
      if (!isObject(result)) throw new Error(`MCP server '${this.serverName}' returned an invalid tools/list result.`);
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) if (isObject(tool)) tools.push(tool as McpToolDescription);
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: argumentsValue });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.failPending(new Error(`MCP server '${this.serverName}' closed.`));
    child.stdin.end();
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    this.child = undefined;
  }

  private request(method: string, params?: JsonObject): Promise<unknown> {
    const child = this.child;
    if (!child || this.closing) return Promise.reject(new Error(`MCP server '${this.serverName}' is not running.`));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server '${this.serverName}' timed out on ${method}.`));
      }, this.config.startupTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: JsonObject): void {
    const child = this.child;
    if (!child || this.closing) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      this.failPending(new Error(`MCP server '${this.serverName}' wrote invalid JSON to stdout.`));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`MCP ${message.error.code ?? "error"}: ${message.error.message ?? "request failed"}`));
      else pending.resolve(message.result);
      return;
    }
    if (this.child && !this.closing) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client request not supported by Jevio." } })}\n`);
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export class McpPluginManager implements PluginToolRegistry {
  private readonly workspace: string;
  private readonly servers: Record<string, McpServerConfig>;
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly connections = new Map<string, McpStdioConnection>();
  private readonly statuses = new Map<string, string>();

  private constructor(workspace: string, servers: Record<string, McpServerConfig>) {
    this.workspace = workspace;
    this.servers = servers;
  }

  static async create(workspace: string, config: JevioConfig): Promise<McpPluginManager> {
    const manager = new McpPluginManager(workspace, config.plugins?.mcp ?? {});
    await manager.connectEnabledServers();
    return manager;
  }

  listTools(role: RoleName): ToolDefinition[] {
    return [...this.bindings.values()]
      .filter((binding) => !binding.roles?.length || binding.roles.includes(role))
      .map((binding) => binding.definition);
  }

  hasTool(name: string): boolean {
    return this.bindings.has(name);
  }

  async execute(name: string, input: Record<string, unknown>, context: PluginExecutionContext): Promise<string> {
    const binding = this.bindings.get(name);
    if (!binding) throw new Error(`Unknown MCP tool '${name}'.`);
    if (!context.autoApprovePlugins) {
      const preview = JSON.stringify(input, null, 2).slice(0, 4_000);
      const approved = await context.confirm(`Разрешить MCP-инструмент ${binding.serverName}/${binding.remoteName}?\n${preview}`);
      if (!approved) return "Permission denied by user.";
    }
    const result = await binding.connection.callTool(binding.remoteName, input);
    return clip(formatToolResult(result), context.maxToolOutputCharacters);
  }

  statusText(): string {
    const names = Object.keys(this.servers);
    if (!names.length) return "MCP-плагины не настроены.";
    return names.map((name) => {
      const status = this.statuses.get(name) ?? "disabled";
      const toolNames = [...this.bindings.values()]
        .filter((binding) => binding.serverName === name)
        .map((binding) => binding.exposedName);
      return `${status === "connected" ? "[x]" : status === "disabled" ? "[-]" : "[!]"} ${name}: ${status}${toolNames.length ? `, tools: ${toolNames.length} (${toolNames.join(", ")})` : ""}`;
    }).join("\n");
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
    this.connections.clear();
    this.bindings.clear();
  }

  private async connectEnabledServers(): Promise<void> {
    for (const [serverName, config] of Object.entries(this.servers)) {
      if (!config.enabled) {
        this.statuses.set(serverName, "disabled");
        continue;
      }
      const connection = new McpStdioConnection(this.workspace, serverName, config);
      try {
        await connection.start();
        const tools = await connection.listTools();
        this.connections.set(serverName, connection);
        this.registerTools(serverName, config, connection, tools);
        this.statuses.set(serverName, "connected");
      } catch (error) {
        await connection.close();
        this.statuses.set(serverName, `error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private registerTools(serverName: string, config: McpServerConfig, connection: McpStdioConnection, tools: McpToolDescription[]): void {
    const used = new Set<string>();
    for (const tool of tools) {
      const remoteName = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!remoteName) continue;
      const baseName = `mcp_${safeToolPart(serverName).slice(0, 20)}_${safeToolPart(remoteName).slice(0, 34)}`;
      let exposedName = baseName;
      let suffix = 2;
      while (used.has(exposedName) || this.bindings.has(exposedName)) exposedName = `${baseName}_${suffix++}`;
      used.add(exposedName);
      const title = typeof tool.title === "string" && tool.title.trim() ? tool.title.trim() : remoteName;
      const description = typeof tool.description === "string" ? tool.description.trim() : "";
      this.bindings.set(exposedName, {
        exposedName,
        serverName,
        remoteName,
        connection,
        roles: config.roles,
        definition: {
          type: "function",
          function: {
            name: exposedName,
            description: `[MCP ${serverName}] ${title}${description ? `: ${description}` : ""}`,
            parameters: normalizeInputSchema(tool.inputSchema),
          },
        },
      });
    }
  }
}

function formatToolResult(result: unknown): string {
  if (!isObject(result)) return JSON.stringify(result ?? null);
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.flatMap((block) => {
    if (!isObject(block)) return [];
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (block.type === "resource_link") return [`[resource] ${String(block.name ?? block.uri ?? "link")}: ${String(block.uri ?? "")}`];
    if (block.type === "resource" && isObject(block.resource) && typeof block.resource.text === "string") return [block.resource.text];
    return [`[MCP ${String(block.type ?? "content")} content omitted]`];
  });
  if (isObject(result.structuredContent)) text.push(JSON.stringify(result.structuredContent, null, 2));
  const output = text.join("\n").trim() || "MCP tool completed without textual output.";
  return result.isError === true ? `MCP tool error:\n${output}` : output;
}
