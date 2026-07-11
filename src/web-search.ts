export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
  source: "duckduckgo-html" | "duckduckgo-ia" | "bing-rss";
}

export interface WebSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stripTags(value: string): string {
  // Decode CDATA/entities first — naive tag strip would wipe CDATA sections.
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Unwrap DuckDuckGo redirect links (`//duckduckgo.com/l/?uddg=...`). */
export function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const url = new URL(absolute, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    return absolute;
  } catch {
    return href;
  }
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const linkPattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)/gi;
  const snippets = [...html.matchAll(snippetPattern)].map((match) => stripTags(match[1]));
  let index = 0;
  for (const match of html.matchAll(linkPattern)) {
    if (hits.length >= maxResults) break;
    const title = stripTags(match[2]);
    const url = unwrapDuckDuckGoUrl(match[1]);
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    hits.push({
      title,
      url,
      snippet: snippets[index] || undefined,
      source: "duckduckgo-html",
    });
    index += 1;
  }
  return hits;
}

export function parseDuckDuckGoInstantAnswer(payload: unknown, maxResults: number): WebSearchHit[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;
  const hits: WebSearchHit[] = [];
  const abstract = typeof data.AbstractText === "string" ? data.AbstractText.trim() : "";
  const abstractUrl = typeof data.AbstractURL === "string" ? data.AbstractURL.trim() : "";
  const heading = typeof data.Heading === "string" ? data.Heading.trim() : "Instant Answer";
  if (abstract && abstractUrl) {
    hits.push({ title: heading, url: abstractUrl, snippet: abstract, source: "duckduckgo-ia" });
  }
  const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  const visit = (items: unknown[]): void => {
    for (const item of items) {
      if (hits.length >= maxResults) return;
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (Array.isArray(record.Topics)) {
        visit(record.Topics);
        continue;
      }
      const text = typeof record.Text === "string" ? record.Text.trim() : "";
      const url = typeof record.FirstURL === "string" ? record.FirstURL.trim() : "";
      if (!text || !url) continue;
      hits.push({
        title: text.slice(0, 120),
        url,
        snippet: text.length > 120 ? text : undefined,
        source: "duckduckgo-ia",
      });
    }
  };
  visit(related);
  return hits.slice(0, maxResults);
}

export function parseBingRss(xml: string, maxResults: number): WebSearchHit[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, maxResults).flatMap((match) => {
    const item = match[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1];
    const link = /<link>([\s\S]*?)<\/link>/.exec(item)?.[1];
    const description = /<description>([\s\S]*?)<\/description>/.exec(item)?.[1];
    if (!title || !link) return [];
    return [{
      title: stripTags(title),
      url: stripTags(link),
      snippet: description ? stripTags(description) : undefined,
      source: "bing-rss" as const,
    }];
  });
}

export function formatWebSearchHits(query: string, hits: WebSearchHit[], backends: string[]): string {
  if (!hits.length) {
    return `No web results for "${query}". Tried: ${backends.join(" → ") || "none"}.`;
  }
  const lines = [
    `Web search: "${query}" (${hits.length} result${hits.length === 1 ? "" : "s"} · ${backends.join(" → ")})`,
    "Paraphrase findings; do not paste long verbatim quotes from sources.",
    "",
    ...hits.map((hit, index) => {
      const snip = hit.snippet ? `\n   ${hit.snippet}` : "";
      return `${index + 1}. ${hit.title}\n   ${hit.url}${snip}`;
    }),
  ];
  return lines.join("\n");
}

async function fetchText(
  url: string,
  options: { timeoutMs: number; fetcher: typeof fetch; headers?: Record<string, string> },
): Promise<string> {
  const response = await options.fetcher(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; JevioFuse/0.1; +https://github.com/theJorDea/JevioFuseHack)",
      accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,ru;q=0.8",
      ...options.headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function fetchJson(
  url: string,
  options: { timeoutMs: number; fetcher: typeof fetch },
): Promise<unknown> {
  const text = await fetchText(url, options);
  return JSON.parse(text) as unknown;
}

/**
 * Multi-backend web search with graceful fallbacks:
 * 1) DuckDuckGo HTML (organic results)
 * 2) DuckDuckGo Instant Answer API (facts / topics)
 * 3) Bing public RSS (legacy fallback)
 */
export async function searchWeb(query: string, maxResults = 5, options: WebSearchOptions = {}): Promise<string> {
  const normalized = query.trim();
  if (!normalized) throw new Error("query must not be empty");
  const limit = Math.max(1, Math.min(10, Math.floor(maxResults) || 5));
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetcher = options.fetcher ?? fetch;
  const backends: string[] = [];
  const merged: WebSearchHit[] = [];
  const seen = new Set<string>();

  const pushHits = (hits: WebSearchHit[], backend: string): void => {
    if (!hits.length) return;
    backends.push(backend);
    for (const hit of hits) {
      const key = hit.url.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
      if (merged.length >= limit) break;
    }
  };

  // 1. DuckDuckGo HTML organic results
  try {
    const html = await fetchText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalized)}`,
      {
        timeoutMs,
        fetcher,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; JevioFuse/0.1; +https://github.com/theJorDea/JevioFuseHack)",
        },
      },
    );
    pushHits(parseDuckDuckGoHtml(html, limit), "duckduckgo-html");
  } catch {
    // continue
  }

  // 2. Instant Answer API for facts / definitions
  if (merged.length < limit) {
    try {
      const payload = await fetchJson(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(normalized)}&format=json&no_html=1&skip_disambig=1`,
        { timeoutMs: Math.min(timeoutMs, 8_000), fetcher },
      );
      pushHits(parseDuckDuckGoInstantAnswer(payload, limit - merged.length), "duckduckgo-ia");
    } catch {
      // continue
    }
  }

  // 3. Bing RSS fallback
  if (merged.length < Math.min(3, limit)) {
    try {
      const xml = await fetchText(
        `https://www.bing.com/search?format=rss&q=${encodeURIComponent(normalized)}`,
        { timeoutMs: Math.min(timeoutMs, 10_000), fetcher },
      );
      pushHits(parseBingRss(xml, limit - merged.length), "bing-rss");
    } catch {
      // continue
    }
  }

  return formatWebSearchHits(normalized, merged.slice(0, limit), backends);
}
