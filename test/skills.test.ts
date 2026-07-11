import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { discoverSkills, parseSkillDocument } from "../src/skills.ts";

test("parses the portable SKILL.md metadata subset", () => {
  const parsed = parseSkillDocument(`---
name: security-review
description: Review code for security defects
when-to-use: When authentication code changes
disable_model_invocation: true
type: prompt
---
# Instructions
`);
  assert.deepEqual(parsed, {
    name: "security-review",
    description: "Review code for security defects",
    whenToUse: "When authentication code changes",
    type: "prompt",
    disableModelInvocation: true,
  });
});

test("discovers .agents skills before Jevio-local duplicates", async (t) => {
  const workspace = path.join(process.cwd(), `.tmp-test-skills-${process.pid}-${Date.now()}`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const portable = path.join(workspace, ".agents", "skills", "review");
  const local = path.join(workspace, ".jevio", "skills", "review");
  await mkdir(portable, { recursive: true });
  await mkdir(local, { recursive: true });
  await writeFile(path.join(portable, "SKILL.md"), `---
name: review
description: Portable review skill
---
Portable
`);
  await writeFile(path.join(local, "SKILL.md"), `---
name: review
description: Lower priority skill
---
Local
`);

  const skills = await discoverSkills(workspace);
  const review = skills.find((skill) => skill.name === "review");
  assert.equal(review?.description, "Portable review skill");
  assert.equal(review?.modelInvocable, true);
  assert.ok(skills.some((skill) => skill.name === "make-interfaces-feel-better"));
  assert.ok(skills.some((skill) => skill.name === "frontend-interface"));
});
