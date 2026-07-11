import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHttpUrl,
  extractReadableText,
  fetchWebPage,
  isBlockedFetchHost,
} from "../src/web-fetch.ts";

test("isBlockedFetchHost rejects private and loopback hosts", () => {
  assert.equal(isBlockedFetchHost("localhost"), true);
  assert.equal(isBlockedFetchHost("127.0.0.1"), true);
  assert.equal(isBlockedFetchHost("10.0.0.5"), true);
  assert.equal(isBlockedFetchHost("192.168.1.1"), true);
  assert.equal(isBlockedFetchHost("169.254.169.254"), true);
  assert.equal(isBlockedFetchHost("example.com"), false);
  assert.equal(isBlockedFetchHost("docs.nodejs.org"), false);
});

test("assertPublicHttpUrl requires http(s) and public hosts", () => {
  assert.equal(assertPublicHttpUrl("https://example.com/docs").hostname, "example.com");
  assert.throws(() => assertPublicHttpUrl("ftp://example.com"), /http/);
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/secret"), /blocked/i);
});

test("extractReadableText strips scripts and keeps title/body", () => {
  const { title, text } = extractReadableText(`
    <html><head><title>Hello &amp; Docs</title>
    <script>alert(1)</script><style>.x{}</style></head>
    <body><main><h1>Intro</h1><p>Useful content about APIs.</p></main></body></html>
  `, 5000);
  assert.equal(title, "Hello & Docs");
  assert.match(text, /Useful content about APIs/);
  assert.doesNotMatch(text, /alert/);
});

test("fetchWebPage returns readable text and blocks private hosts", async () => {
  await assert.rejects(
    () => fetchWebPage("http://192.168.0.10/x"),
    /blocked/i,
  );

  const page = await fetchWebPage("https://example.com/page", {
    fetcher: async () => new Response(`
      <html><head><title>Example</title></head>
      <body><article><p>Official documentation paragraph.</p></article></body></html>
    `, { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.match(page, /Title: Example/);
  assert.match(page, /Official documentation/);
});
