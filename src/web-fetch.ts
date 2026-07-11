export interface WebFetchOptions {
  maxCharacters?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

/** True if the host looks like a non-public / SSRF-prone target. */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv4 private / loopback / link-local
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.some((part) => part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback / ULA / link-local (rough)
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL must be an absolute http(s) URL.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https URLs are allowed.");
  if (isBlockedFetchHost(url.hostname)) {
    throw new Error(`Fetching host '${url.hostname}' is blocked (private/local/metadata).`);
  }
  return url;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Strip scripts/styles/nav noise and collapse whitespace for model consumption. */
export function extractReadableText(html: string, maxCharacters: number): { title: string; text: string } {
  let body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const title = decodeEntities(
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  // Prefer main/article when present.
  const main =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1]
    ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1]
    ?? body;

  let text = main
    .replace(/<\/(p|div|h[1-6]|li|tr|section|br|hr)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "");
  text = decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (text.length > maxCharacters) {
    text = `${text.slice(0, Math.max(0, maxCharacters - 1))}…`;
  }
  return { title: title || "(no title)", text };
}

/**
 * Fetch a public web page and return readable text for the model.
 * Blocks private/local hosts (SSRF guard).
 */
export async function fetchWebPage(rawUrl: string, options: WebFetchOptions = {}): Promise<string> {
  const url = assertPublicHttpUrl(rawUrl);
  const maxCharacters = Math.max(1_000, Math.min(40_000, options.maxCharacters ?? 14_000));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetcher = options.fetcher ?? fetch;

  const response = await fetcher(url.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; JevioFuse/0.1; +https://github.com/theJorDea/JevioFuseHack)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      "accept-language": "en-US,en;q=0.9,ru;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: HTTP ${response.status} for ${url.toString()}`);
  }

  // Re-check final URL after redirects when available.
  const finalUrl = response.url ? new URL(response.url) : url;
  if (isBlockedFetchHost(finalUrl.hostname)) {
    throw new Error(`Fetch redirected to blocked host '${finalUrl.hostname}'.`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const body = await response.text();

  if (contentType.includes("application/json") || body.trim().startsWith("{") || body.trim().startsWith("[")) {
    const clipped = body.length > maxCharacters ? `${body.slice(0, maxCharacters - 1)}…` : body;
    return [
      `URL: ${finalUrl.toString()}`,
      `Content-Type: ${contentType || "application/json"}`,
      "",
      clipped,
    ].join("\n");
  }

  if (contentType.includes("text/plain") || (!contentType.includes("html") && !body.includes("<html"))) {
    const clipped = body.length > maxCharacters ? `${body.slice(0, maxCharacters - 1)}…` : body;
    return [
      `URL: ${finalUrl.toString()}`,
      `Content-Type: ${contentType || "text/plain"}`,
      "",
      clipped.trim(),
    ].join("\n");
  }

  const { title, text } = extractReadableText(body, maxCharacters);
  if (!text) throw new Error(`No readable text extracted from ${finalUrl.toString()}.`);
  return [
    `URL: ${finalUrl.toString()}`,
    `Title: ${title}`,
    `Content-Type: ${contentType || "text/html"}`,
    `Characters: ${text.length}${body.length > maxCharacters ? " (truncated)" : ""}`,
    "",
    text,
  ].join("\n");
}
