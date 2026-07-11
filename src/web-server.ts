#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebHost, type WebStreamEvent } from "./web-host.ts";
import { shutdownTelemetry } from "./telemetry.ts";
import type { ExecutionMode } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "../web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  let rel = decodeURIComponent(urlPath.split("?")[0] || "/");
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function writeSse(res: ServerResponse, event: WebStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export interface WebServerOptions {
  workspace?: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  yolo?: boolean;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const workspace = path.resolve(options.workspace || process.cwd());
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 8787;
  const webHost = await WebHost.create(workspace);
  if (options.yolo) webHost.setYolo(true);

  const server = createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, webHost.status());
        return;
      }
      if (method === "GET" && pathname === "/api/sessions") {
        sendJson(res, 200, await webHost.listSessions());
        return;
      }
      if (method === "GET" && pathname === "/api/history") {
        sendJson(res, 200, { sessionId: webHost.status().sessionId, messages: webHost.getHistory() });
        return;
      }
      if (method === "POST" && pathname === "/api/sessions") {
        sendJson(res, 200, await webHost.newSession());
        return;
      }
      if (method === "POST" && pathname === "/api/sessions/resume") {
        const body = await readJson<{ id?: string }>(req);
        if (!body.id) {
          sendJson(res, 400, { error: "id required" });
          return;
        }
        sendJson(res, 200, await webHost.resumeSession(body.id));
        return;
      }
      if (method === "POST" && pathname === "/api/mode") {
        const body = await readJson<{ mode?: ExecutionMode }>(req);
        if (!body.mode) {
          sendJson(res, 400, { error: "mode required" });
          return;
        }
        webHost.setMode(body.mode);
        sendJson(res, 200, { ok: true, mode: body.mode });
        return;
      }
      if (method === "POST" && pathname === "/api/yolo") {
        const body = await readJson<{ on?: boolean }>(req);
        webHost.setYolo(Boolean(body.on));
        sendJson(res, 200, { ok: true, yolo: Boolean(body.on) });
        return;
      }
      if (method === "GET" && pathname === "/api/settings") {
        sendJson(res, 200, webHost.getSettings());
        return;
      }
      if (method === "GET" && pathname === "/api/models") {
        const provider = url.searchParams.get("provider") || undefined;
        sendJson(res, 200, await webHost.listModels(provider));
        return;
      }
      if (method === "POST" && pathname === "/api/settings/provider") {
        const body = await readJson<{ name?: string; applyDefaultModel?: boolean }>(req);
        if (!body.name) {
          sendJson(res, 400, { error: "name required" });
          return;
        }
        const message = await webHost.applyProvider(body.name, Boolean(body.applyDefaultModel));
        sendJson(res, 200, { ok: true, message, settings: webHost.getSettings(), status: webHost.status() });
        return;
      }
      if (method === "POST" && pathname === "/api/settings/model") {
        const body = await readJson<{ model?: string; provider?: string }>(req);
        if (!body.model?.trim()) {
          sendJson(res, 400, { error: "model required" });
          return;
        }
        const message = await webHost.applyModel(body.model, body.provider);
        sendJson(res, 200, { ok: true, message, settings: webHost.getSettings(), status: webHost.status() });
        return;
      }
      if (method === "POST" && pathname === "/api/interact") {
        const body = await readJson<{ id?: string; answer?: boolean | string }>(req);
        if (!body.id) {
          sendJson(res, 400, { error: "id required" });
          return;
        }
        const ok = webHost.resolveInteraction(body.id, body.answer ?? false);
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "unknown interaction" });
        return;
      }
      if (method === "POST" && pathname === "/api/stop") {
        const stopped = webHost.stopChat();
        sendJson(res, stopped ? 200 : 409, stopped
          ? { ok: true, message: "Выполнение останавливается." }
          : { error: "Нет активной задачи." });
        return;
      }
      if (method === "POST" && pathname === "/api/chat") {
        const body = await readJson<{ message?: string }>(req);
        const message = body.message?.trim() || "";
        if (!message) {
          sendJson(res, 400, { error: "message required" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.write(": ok\n\n");
        try {
          for await (const event of webHost.runChat(message)) {
            writeSse(res, event);
          }
        } catch (error) {
          writeSse(res, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        res.end();
        return;
      }

      if (method === "GET") {
        await serveStatic(res, pathname);
        return;
      }

      sendText(res, 405, "Method not allowed");
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const url = `http://${host}:${port}`;
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }).finally(() => shutdownTelemetry()),
  };
}

async function main(argv: string[]): Promise<void> {
  let workspace = process.cwd();
  let port = Number(process.env.JEVIO_WEB_PORT || 8787);
  let host = process.env.JEVIO_WEB_HOST || "127.0.0.1";
  let yolo = false;
  let openBrowser = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") workspace = path.resolve(argv[++i] || workspace);
    else if (arg === "--port" || arg === "-p") port = Number(argv[++i] || port);
    else if (arg === "--host") host = argv[++i] || host;
    else if (arg === "--yolo" || arg === "--yes" || arg === "-y") yolo = true;
    else if (arg === "--no-open") openBrowser = false;
  }

  const { url } = await startWebServer({ workspace, host, port, yolo, openBrowser });
  process.stdout.write(`\nFuse web: ${url}\n`);
  process.stdout.write(`Workspace: ${path.resolve(workspace)}\n`);
  process.stdout.write("Открой ссылку в браузере. Ctrl+C — стоп.\n\n");

  if (openBrowser) {
    const platform = process.platform;
    const { execFile } = await import("node:child_process");
    try {
      if (platform === "win32") execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
      else if (platform === "darwin") execFile("open", [url]);
      else execFile("xdg-open", [url]);
    } catch {
      // ignore
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
