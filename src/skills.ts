import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillMetadata } from "./types.ts";

interface ParsedSkill {
  name?: string;
  description?: string;
  whenToUse?: string;
  type?: string;
  disableModelInvocation?: boolean;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillDocument(content: string): ParsedSkill {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return {};

  const values: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) values[match[1].toLowerCase().replace(/[-_]/g, "")] = scalar(match[2]);
  }
  return {
    name: values.name,
    description: values.description,
    whenToUse: values.whentouse,
    type: values.type,
    disableModelInvocation: values.disablemodelinvocation?.toLowerCase() === "true",
  };
}

function firstBodyLine(document: string): string | undefined {
  const body = document.replace(/^---[\s\S]*?---\s*/, "");
  return body.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 240);
}

export async function discoverSkills(workspace: string): Promise<SkillMetadata[]> {
  // Project-specific skills take precedence over the bundled defaults.
  const roots = [
    path.join(workspace, ".agents", "skills"),
    path.join(workspace, ".jevio", "skills"),
    path.join(workspace, "skills"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "default-skills"),
  ];
  const found = new Map<string, SkillMetadata>();

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !(entry.isFile() && entry.name.endsWith(".md"))) continue;
      const skillFile = entry.isDirectory()
        ? path.join(root, entry.name, "SKILL.md")
        : path.join(root, entry.name);
      try {
        const document = await readFile(skillFile, "utf8");
        const manifest = parseSkillDocument(document);
        const fallbackName = entry.isDirectory() ? entry.name : path.basename(entry.name, ".md");
        const name = manifest.name?.trim() || fallbackName;
        const description = manifest.description?.trim() || firstBodyLine(document);
        if (manifest.type && !["prompt", "inline", "flow"].includes(manifest.type)) continue;
        if (!description || found.has(name.toLowerCase())) continue;
        found.set(name.toLowerCase(), {
          name,
          description,
          whenToUse: manifest.whenToUse,
          modelInvocable: manifest.type !== "flow" && !manifest.disableModelInvocation,
          path: skillFile,
        });
      } catch {
        // One malformed skill must not prevent the rest of the catalog from loading.
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkill(skill: SkillMetadata): Promise<string> {
  return readFile(skill.path, "utf8");
}

export function formatSkillCatalog(skills: SkillMetadata[]): string {
  const available = skills.filter((skill) => skill.modelInvocable);
  if (!available.length) return "No model-invocable project skills are installed.";
  return available.map((skill) =>
    `- ${skill.name}: ${skill.description}${skill.whenToUse ? ` (use when: ${skill.whenToUse})` : ""}`,
  ).join("\n");
}
