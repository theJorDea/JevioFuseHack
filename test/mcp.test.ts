import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { McpPluginManager } from "../src/mcp.ts";
import { executeTool, toolsForRole } from "../src/tools.ts";

const MCP_FIXTURE = `
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.params?.cursor
      ? { tools: [{ name: "second", description: "Second tool", inputSchema: { type: "object", properties: {} } }] }
      : { tools: [{ name: "echo", title: "Echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }], nextCursor: "page-2" } });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.name + ": " + JSON.stringify(message.params.arguments) }] } });
  }
}
`;

test("MCP stdio plugins discover paginated tools and preserve approval", async (t) => {
  const workspace = await mkdtemp(path.join(process.cwd(), ".tmp-test-mcp-"));
  let manager: McpPluginManager | undefined;
  t.after(async () => {
    await manager?.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const fixture = path.join(workspace, "mcp-fixture.mjs");
  await writeFile(fixture, MCP_FIXTURE, "utf8");

  const config = structuredClone(DEFAULT_CONFIG);
  config.plugins.mcp = {
    demo: {
      command: process.execPath,
      args: [fixture],
      env: {},
      cwd: ".",
      enabled: true,
      roles: ["coder"],
      startupTimeoutMs: 5_000,
    },
  };
  manager = await McpPluginManager.create(workspace, config);

  assert.match(manager.statusText(), /\[x\] demo: connected, tools: 2/);
  const coderTools = toolsForRole("coder", manager);
  assert.ok(coderTools.some((tool) => tool.function.name === "mcp_demo_echo"));
  assert.ok(coderTools.some((tool) => tool.function.name === "mcp_demo_second"));
  assert.equal(toolsForRole("architect", manager).some((tool) => tool.function.name === "mcp_demo_echo"), false);

  const denied = await executeTool("mcp_demo_echo", { value: "hello" }, {
    workspace,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    autoApprovePlugins: false,
    confirm: async () => false,
    plugins: manager,
  });
  assert.equal(denied, "Permission denied by user.");

  let prompt = "";
  const result = await executeTool("mcp_demo_echo", { value: "hello" }, {
    workspace,
    skills: [],
    autoApproveWrites: false,
    autoApproveShell: false,
    autoApprovePlugins: false,
    confirm: async (message) => { prompt = message; return true; },
    plugins: manager,
  });
  assert.match(prompt, /demo\/echo/);
  assert.equal(result, 'echo: {"value":"hello"}');
});
