import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWebSearchHits,
  parseBingRss,
  parseDuckDuckGoHtml,
  parseDuckDuckGoInstantAnswer,
  searchWeb,
  unwrapDuckDuckGoUrl,
} from "../src/web-search.ts";

test("unwrapDuckDuckGoUrl extracts uddg target", () => {
  const href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2Fhandbook%2F2%2Fgenerics.html&rut=abc";
  assert.equal(unwrapDuckDuckGoUrl(href), "https://www.typescriptlang.org/docs/handbook/2/generics.html");
});

test("parseDuckDuckGoHtml extracts title, unwrapped url, and snippet", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fdocs">Official <b>docs</b></a>
    <a class="result__snippet">Useful <b>reference</b> material</a>
  `;
  const hits = parseDuckDuckGoHtml(html, 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Official docs");
  assert.equal(hits[0].url, "https://example.test/docs");
  assert.match(hits[0].snippet ?? "", /Useful reference/);
  assert.equal(hits[0].source, "duckduckgo-html");
});

test("parseDuckDuckGoInstantAnswer reads abstract and related topics", () => {
  const hits = parseDuckDuckGoInstantAnswer({
    Heading: "Node.js",
    AbstractText: "JavaScript runtime",
    AbstractURL: "https://nodejs.org/",
    RelatedTopics: [
      { Text: "npm package manager", FirstURL: "https://www.npmjs.com/" },
      { Topics: [{ Text: "V8 engine", FirstURL: "https://v8.dev/" }] },
    ],
  }, 5);
  assert.equal(hits[0].url, "https://nodejs.org/");
  assert.ok(hits.some((hit) => hit.url === "https://www.npmjs.com/"));
  assert.ok(hits.some((hit) => hit.url === "https://v8.dev/"));
});

test("parseBingRss still works as fallback format", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Official docs]]></title><link>https://example.test/docs</link><description><![CDATA[<b>Useful</b> reference]]></description></item>
  </channel></rss>`;
  const hits = parseBingRss(xml, 5);
  assert.equal(hits[0].title, "Official docs");
  assert.equal(hits[0].url, "https://example.test/docs");
  assert.match(hits[0].snippet ?? "", /Useful reference/);
});

test("searchWeb tries backends in order and formats numbered results", async () => {
  const urls: string[] = [];
  const result = await searchWeb("typescript generics", 3, {
    fetcher: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("html.duckduckgo.com")) {
        return new Response(`
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs">TS Generics</a>
          <a class="result__snippet">Handbook section</a>
        `, { status: 200 });
      }
      if (url.includes("api.duckduckgo.com")) {
        return new Response(JSON.stringify({
          Heading: "Generics",
          AbstractText: "Parameterized types",
          AbstractURL: "https://en.wikipedia.org/wiki/Generic_programming",
        }), { status: 200 });
      }
      return new Response("", { status: 500 });
    },
  });
  assert.match(result, /Web search: "typescript generics"/);
  assert.match(result, /1\. TS Generics/);
  assert.match(result, /typescriptlang\.org/);
  assert.match(result, /duckduckgo-html/);
  assert.ok(urls.some((url) => url.includes("html.duckduckgo.com")));
});

test("formatWebSearchHits reports empty backends clearly", () => {
  assert.match(formatWebSearchHits("x", [], ["duckduckgo-html"]), /No web results/);
});

test("formatWebSearchHits reminds models to paraphrase sources", () => {
  const text = formatWebSearchHits("q", [{ title: "T", url: "https://e.test", source: "duckduckgo-html" }], ["duckduckgo-html"]);
  assert.match(text, /Paraphrase/);
});
