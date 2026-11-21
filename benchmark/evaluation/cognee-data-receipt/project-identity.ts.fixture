import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CogneeMemoryConfig } from "./types.ts";

export interface ProjectIdentity {
  id: string;
  dataset: string;
  createdAt: string;
}

function identityPath(workspace: string): string {
  return path.join(path.resolve(workspace), ".jevio", "project.json");
}

export function legacyProjectDataset(workspace: string): string {
  const resolved = path.resolve(workspace);
  const name = path.basename(resolved).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `jevio-${name.slice(0, 40)}-${hash}`;
}

function parseIdentity(document: string, file: string): ProjectIdentity {
  let value: unknown;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error(`Invalid Jevio project identity JSON: ${file}`);
  }
  if (!value || typeof value !== "object") throw new Error(`Invalid Jevio project identity: ${file}`);
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id)) throw new Error(`Invalid Jevio project id: ${file}`);
  if (typeof item.dataset !== "string" || !item.dataset.trim()) throw new Error(`Invalid Jevio project dataset: ${file}`);
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new Error(`Invalid Jevio project creation date: ${file}`);
  return { id: item.id, dataset: item.dataset.trim(), createdAt: item.createdAt };
}

async function readIdentity(file: string): Promise<ProjectIdentity> {
  return parseIdentity(await readFile(file, "utf8"), file);
}

export async function loadProjectIdentity(workspace: string): Promise<ProjectIdentity> {
  const file = identityPath(workspace);
  try {
    return await readIdentity(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const identity: ProjectIdentity = {
    id: randomUUID(),
    dataset: legacyProjectDataset(workspace),
    createdAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readIdentity(file);
  }
}

export function cogneeConfigForProject(config: CogneeMemoryConfig, identity: ProjectIdentity): CogneeMemoryConfig {
  return config.dataset?.trim() ? config : { ...config, dataset: identity.dataset };
}
