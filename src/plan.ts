import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type PlanStatus = "pending" | "approved" | "rejected";

export interface PlanDocument {
  path: string;
  sessionId: string;
  createdAt: string;
  feedback: string[];
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " "));
}

export async function createPlanDocument(workspace: string, sessionId: string): Promise<PlanDocument> {
  const directory = path.join(path.resolve(workspace), ".jevio", "plans");
  await mkdir(directory, { recursive: true });
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { path: path.join(directory, `${timestamp}-${sessionId.slice(-8)}.md`), sessionId, createdAt, feedback: [] };
}

export async function writePlanDocument(document: PlanDocument, plan: string, status: PlanStatus): Promise<string> {
  const feedback = document.feedback.length
    ? `\n## Предложения пользователя\n\n${document.feedback.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n`
    : "";
  await writeFile(document.path, `---
sessionId: ${yamlString(document.sessionId)}
createdAt: ${yamlString(document.createdAt)}
updatedAt: ${yamlString(new Date().toISOString())}
status: ${status}
format: jevio-plan-v1
---

# План реализации

${plan.trim()}
${feedback}`, "utf8");
  return document.path;
}
