import assert from "node:assert/strict";
import test from "node:test";
import { CogneeMemory, completedTurnMemory } from "../src/memory.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

function config() {
  const value = structuredClone(DEFAULT_CONFIG.memory.cognee);
  value.enabled = true;
  value.dataset = "test-project";
  return value;
}

test("Cognee recall is dataset-scoped, authenticated, deduplicated, and bounded", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  process.env.COGNEE_TEST_KEY = "secret";
  const options = config();
  options.apiKeyEnv = "COGNEE_TEST_KEY";
  options.maxResults = 2;
  options.maxContextCharacters = 100;
  const memory = new CogneeMemory(options, process.cwd(), async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ results: [{ text: "first" }, { text: "first" }, { content: "second" }, { text: "third" }] }), { status: 200 });
  });
  const result = await memory.recall("fix parser", "session-1");
  delete process.env.COGNEE_TEST_KEY;

  assert.equal(result, "first\n\n---\n\nsecond");
  assert.equal(requests[0].url, "http://localhost:8000/api/v1/recall");
  assert.equal(new Headers(requests[0].init?.headers).get("x-api-key"), "secret");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    query: "fix parser",
    top_k: 2,
    only_context: true,
    scope: "auto",
    datasets: ["test-project"],
    session_id: "session-1",
  });
});

test("Cognee remember uploads Markdown into the project dataset", async () => {
  let body: FormData | undefined;
  const memory = new CogneeMemory(config(), process.cwd(), async (_input, init) => {
    body = init?.body as FormData;
    return new Response("{}", { status: 200 });
  });
  await memory.remember("durable decision", "session-2", "decision.md");
  assert.equal(body?.get("datasetName"), "test-project");
  assert.equal(body?.get("session_id"), null);
  assert.equal(body?.get("run_in_background"), "true");
  assert.equal(await (body?.get("data") as Blob).text(), "durable decision");
});

test("Cognee recall treats a missing project dataset as empty memory", async () => {
  const memory = new CogneeMemory(config(), process.cwd(), async () => new Response(JSON.stringify({
    error: "Search prerequisites not met",
    detail: "DatasetNotFoundError: No datasets found.",
  }), { status: 404 }));
  assert.equal(await memory.recall("new project"), "");
});

test("Cognee recall retries a transient database creation race", async () => {
  let calls = 0;
  const memory = new CogneeMemory(config(), process.cwd(), async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ detail: "UniqueViolationError: database already exists" }), { status: 500 })
      : new Response(JSON.stringify({ results: [{ text: "ready" }] }), { status: 200 });
  });
  assert.equal(await memory.recall("race"), "ready");
  assert.equal(calls, 2);
});

test("Cognee recall falls back to the legacy search endpoint", async () => {
  const urls: string[] = [];
  const memory = new CogneeMemory(config(), process.cwd(), async (input) => {
    const url = String(input);
    urls.push(url);
    return url.endsWith("/recall")
      ? new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })
      : new Response(JSON.stringify({ results: [{ text: "legacy" }] }), { status: 200 });
  });
  assert.equal(await memory.recall("old server"), "legacy");
  assert.deepEqual(urls.map((url) => url.split("/").at(-1)), ["recall", "search"]);
});

test("Cognee forget deletes only the matching project dataset", async () => {
  const urls: string[] = [];
  const memory = new CogneeMemory(config(), process.cwd(), async (input) => {
    const url = String(input);
    urls.push(url);
    return url.endsWith("/datasets")
      ? new Response(JSON.stringify({ datasets: [{ id: "other-id", name: "other" }, { id: "project-id", name: "test-project" }] }), { status: 200 })
      : new Response(null, { status: 204 });
  });
  assert.equal(await memory.forget(), true);
  assert.equal(urls[1], "http://localhost:8000/api/v1/datasets/project-id");
});

test("Cognee status reports missing configured credentials without a request", async () => {
  const options = config();
  options.apiKeyEnv = "MISSING_COGNEE_TEST_KEY";
  let called = false;
  const memory = new CogneeMemory(options, process.cwd(), async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  assert.match((await memory.status()).detail, /missing MISSING_COGNEE_TEST_KEY/);
  assert.equal(called, false);
});

test("completed turn memory contains the request and result", () => {
  assert.match(completedTurnMemory("Fix it", "Done"), /Fix it[\s\S]*Done/);
});
