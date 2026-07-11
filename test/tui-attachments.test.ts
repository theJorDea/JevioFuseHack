import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  composeMessageWithAttachments,
  extractAtMentions,
  loadAtAttachments,
} from "../src/tui-attachments.ts";

test("extractAtMentions finds paths and skips emails/handles", () => {
  assert.deepEqual(
    extractAtMentions("Look at @src/cli.ts and @\"docs/my file.md\""),
    ["src/cli.ts", "docs/my file.md"],
  );
  assert.deepEqual(extractAtMentions("email me at user@example.com please"), []);
  assert.deepEqual(extractAtMentions("see @README.md"), ["README.md"]);
  assert.deepEqual(extractAtMentions("ping @alice later"), []);
  assert.deepEqual(extractAtMentions("both @src/a.ts and @src/a.ts"), ["src/a.ts"]);
});

test("loadAtAttachments reads workspace files into context", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-attach-${process.pid}-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "src", "hello.ts"), "export const n = 1;\n", "utf8");

  const result = await loadAtAttachments(workspace, "Explain @src/hello.ts please");
  assert.deepEqual(result.loaded, ["src/hello.ts"]);
  assert.equal(result.missing.length, 0);
  assert.match(result.contextBlock, /### src\/hello\.ts/);
  assert.match(result.contextBlock, /export const n = 1/);

  const composed = composeMessageWithAttachments("Explain @src/hello.ts", result);
  assert.match(composed, /Explain @src\/hello\.ts/);
  assert.match(composed, /Attached files/);
});

test("loadAtAttachments reports missing and escapes path traversal", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-attach-miss-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const missing = await loadAtAttachments(workspace, "open @nope.ts");
  assert.deepEqual(missing.loaded, []);
  assert.ok(missing.missing.some((item) => item.includes("nope.ts")));

  const escape = await loadAtAttachments(workspace, "open @../secret.txt");
  assert.deepEqual(escape.loaded, []);
  assert.ok(escape.missing.length >= 1);
});
