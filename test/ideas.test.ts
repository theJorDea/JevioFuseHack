import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatIdeaSignals, gatherIdeaSignals, generateIdeas } from "../src/ideas.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-ideas-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("gatherIdeaSignals reads package metadata and top-level layout", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "demo-app",
    description: "Demo",
    scripts: { test: "node --test", start: "node src/cli.ts" },
  }));
  await writeFile(path.join(root, "README.md"), "# Demo\n\nHello world\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export {};\n");

  const signals = await gatherIdeaSignals(root, structuredClone(DEFAULT_CONFIG));
  assert.equal(signals.packageName, "demo-app");
  assert.ok(signals.scripts.includes("test"));
  assert.match(signals.readmeExcerpt, /Hello world/);
  assert.ok(signals.topLevel.some((item) => item.includes("src")));
  assert.match(formatIdeaSignals(signals), /demo-app/);
});

test("generateIdeas uses architect with elevated temperature and returns markdown", async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fuse-demo", scripts: { test: "npm test" } }));
  let seenTemp: number | undefined;
  let seenTask = "";
  const output = await generateIdeas({
    workspace: root,
    config: structuredClone(DEFAULT_CONFIG),
    toolContext: {
      workspace: root,
      skills: [],
      autoApproveWrites: true,
      autoApproveShell: true,
      confirm: async () => true,
    },
    topic: "DX",
    count: 5,
    runner: async (options) => {
      seenTemp = options.config.roles.architect.temperature;
      seenTask = options.task;
      assert.equal(options.role, "architect");
      assert.equal(options.toolContext.autoApproveWrites, false);
      return {
        content: `### 1. Better DX scripts
- **Why:** faster loop
- **How:** touch package.json
- **Effort / impact:** S / M
- **Start:** add npm run check
`,
        role: "architect",
        turns: 1,
      };
    },
  });
  assert.ok((seenTemp ?? 0) >= 0.55);
  assert.match(seenTask, /DX/);
  assert.match(seenTask, /5 concrete ideas|Generate 5/i);
  assert.match(output, /Идеи для fuse-demo/);
  assert.match(output, /Better DX scripts/);
});
