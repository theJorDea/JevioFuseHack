import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CodeIndexConfig } from "./types.ts";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([".git", ".jevio", "node_modules", "dist", "build", ".next", "vendor"]);
const MAX_FILE_BYTES = 2_000_000;

export interface SymbolDefinition {
  name: string;
  kind: string;
  path: string;
  line: number;
  scope?: string;
  signature?: string;
  language?: string;
}

export interface SymbolReference {
  path: string;
  line: number;
  importedAs?: string;
  source?: string;
}

interface SymbolIndex {
  definitions: Map<string, SymbolDefinition[]>;
  references: Map<string, SymbolReference[]>;
  backend: "ctags" | "builtin";
  indexedFiles: number;
  builtAt: number;
}

interface CachedIndex {
  configKey: string;
  index: SymbolIndex;
}

const cache = new Map<string, CachedIndex>();
let ctagsAvailable: boolean | undefined;

export interface CtagsStatus {
  available: boolean;
  detail: string;
}

export async function getCtagsStatus(): Promise<CtagsStatus> {
  if (ctagsAvailable === false) return { available: false, detail: "Universal Ctags is not available" };
  try {
    const result = await execFileAsync("ctags", ["--version"], { windowsHide: true });
    const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] || "unknown version";
    if (!/universal\s+ctags/i.test(version)) {
      ctagsAvailable = false;
      return { available: false, detail: `Universal Ctags is required; found ${version}` };
    }
    ctagsAvailable = true;
    return { available: true, detail: version };
  } catch {
    ctagsAvailable = false;
    return { available: false, detail: "Universal Ctags was not found on PATH" };
  }
}

function configKey(config: CodeIndexConfig): string {
  return [config.backend, config.maxFiles].join(":");
}

function addDefinition(index: SymbolIndex, definition: SymbolDefinition): void {
  const key = definition.name.toLowerCase();
  const existing = index.definitions.get(key) ?? [];
  if (!existing.some((item) => item.path === definition.path && item.line === definition.line && item.kind === definition.kind)) {
    existing.push(definition);
    index.definitions.set(key, existing);
  }
}

function addReference(index: SymbolIndex, name: string, reference: SymbolReference): void {
  const key = name.toLowerCase();
  const existing = index.references.get(key) ?? [];
  if (!existing.some((item) => item.path === reference.path && item.line === reference.line && item.importedAs === reference.importedAs)) {
    existing.push(reference);
    index.references.set(key, existing);
  }
}

async function collectFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await visit(root);
  return files;
}

function languageFor(file: string): string | undefined {
  const extension = path.extname(file).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "typescript";
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if ([".java", ".kt", ".kts"].includes(extension)) return "jvm";
  if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"].includes(extension)) return "cpp";
  if (extension === ".cs") return "csharp";
  if (extension === ".rb") return "ruby";
  if (extension === ".php") return "php";
  return undefined;
}

function captureImports(index: SymbolIndex, language: string, line: string, relativePath: string, lineNumber: number): void {
  if (language === "typescript") {
    const named = /import\s*\{([^}]+)\}/.exec(line);
    if (named) {
      for (const item of named[1].split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        const original = parts[0]?.trim();
        if (original) addReference(index, original, {
          path: relativePath,
          line: lineNumber,
          importedAs: parts[1]?.trim(),
          source: line.trim(),
        });
      }
    }
    const defaultImport = /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+/.exec(line);
    if (defaultImport) addReference(index, defaultImport[1], { path: relativePath, line: lineNumber, source: line.trim() });
    return;
  }
  if (language === "python") {
    const named = /^\s*from\s+[^\s]+\s+import\s+(.+)$/.exec(line);
    if (named) {
      for (const item of named[1].split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        if (parts[0]) addReference(index, parts[0], {
          path: relativePath,
          line: lineNumber,
          importedAs: parts[1],
          source: line.trim(),
        });
      }
    }
    return;
  }
  if (language === "jvm") {
    const imported = /^\s*import\s+([\w.]+);?/.exec(line);
    if (imported) {
      const name = imported[1].split(".").at(-1);
      if (name && name !== "*") addReference(index, name, { path: relativePath, line: lineNumber, source: line.trim() });
    }
  }
}

function scanFile(index: SymbolIndex, relativePath: string, content: string, language: string): void {
  const lines = content.split(/\r?\n/);
  let scope: { name: string; depth: number } | undefined;
  let depth = 0;
  for (const [offset, line] of lines.entries()) {
    const lineNumber = offset + 1;
    const trimmed = line.trim();
    if (scope && depth < scope.depth) scope = undefined;
    captureImports(index, language, line, relativePath, lineNumber);

    const add = (name: string, kind: string, signature?: string): void => {
      addDefinition(index, { name, kind, path: relativePath, line: lineNumber, scope: scope?.name, signature, language });
    };

    if (language === "typescript") {
      const type = /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (type) {
        add(type[2], type[1], trimmed);
        if (["class", "interface", "namespace"].includes(type[1])) scope = { name: type[2], depth: depth + 1 };
      }
      const functionMatch = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/.exec(line);
      if (functionMatch) add(functionMatch[1], "function", `${functionMatch[1]}${functionMatch[2] ?? "()"}`);
      const variable = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/.exec(line);
      if (variable) add(variable[1], "variable", trimmed);
      const method = /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*(?::[^={]+)?\s*(?:\{|=>)/.exec(line);
      if (method && !["if", "for", "while", "switch", "catch"].includes(method[1])) add(method[1], scope ? "method" : "function", `${method[1]}${method[2]}`);
    } else if (language === "python") {
      const type = /^\s*class\s+([A-Za-z_]\w*)/.exec(line);
      if (type) {
        add(type[1], "class", trimmed);
        scope = { name: type[1], depth: depth + 1 };
      }
      const functionMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\))/.exec(line);
      if (functionMatch) add(functionMatch[1], scope ? "method" : "function", `${functionMatch[1]}${functionMatch[2]}`);
    } else if (language === "go") {
      const type = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)/.exec(line);
      if (type) add(type[1], type[2], trimmed);
      const functionMatch = /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*(\([^)]*\))/.exec(line);
      if (functionMatch) add(functionMatch[1], "function", `${functionMatch[1]}${functionMatch[2]}`);
    } else if (language === "rust") {
      const type = /^\s*(?:pub\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/.exec(line);
      if (type) add(type[2], type[1], trimmed);
      const functionMatch = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(\([^)]*\))/.exec(line);
      if (functionMatch) add(functionMatch[1], "function", `${functionMatch[1]}${functionMatch[2]}`);
    } else if (language === "jvm" || language === "csharp" || language === "cpp") {
      const type = /^\s*(?:public|private|protected|internal|abstract|final|static|sealed|partial|export\s+)?\s*(class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/.exec(line);
      if (type) {
        add(type[2], type[1], trimmed);
        scope = { name: type[2], depth: depth + 1 };
      }
      const functionMatch = /^\s*(?:public|private|protected|internal|static|virtual|override|async|final|inline|constexpr|\s)+[\w<>\[\],?*:& ]+\s+([A-Za-z_]\w*)\s*(\([^)]*\))\s*(?:\{|=>|throws)/.exec(line);
      if (functionMatch) add(functionMatch[1], scope ? "method" : "function", `${functionMatch[1]}${functionMatch[2]}`);
    } else if (language === "ruby") {
      const type = /^\s*(class|module)\s+([A-Za-z_]\w*)/.exec(line);
      if (type) add(type[2], type[1], trimmed);
      const functionMatch = /^\s*def\s+([A-Za-z_]\w*[!?=]?)/.exec(line);
      if (functionMatch) add(functionMatch[1], "method", trimmed);
    } else if (language === "php") {
      const type = /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(line);
      if (type) add(type[2], type[1], trimmed);
      const functionMatch = /^\s*(?:public|private|protected|static|final|abstract|\s)*function\s+([A-Za-z_]\w*)\s*(\([^)]*\))/.exec(line);
      if (functionMatch) add(functionMatch[1], "function", `${functionMatch[1]}${functionMatch[2]}`);
    }

    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
}

async function buildBuiltinIndex(workspace: string, config: CodeIndexConfig): Promise<SymbolIndex> {
  const index: SymbolIndex = {
    definitions: new Map(),
    references: new Map(),
    backend: "builtin",
    indexedFiles: 0,
    builtAt: Date.now(),
  };
  const files = await collectFiles(workspace, config.maxFiles);
  for (const file of files) {
    const language = languageFor(file);
    if (!language) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES || content.includes("\0")) continue;
    scanFile(index, path.relative(workspace, file), content, language);
    index.indexedFiles += 1;
  }
  return index;
}

async function enrichWithCtags(index: SymbolIndex, workspace: string): Promise<boolean> {
  if (ctagsAvailable === undefined && !(await getCtagsStatus()).available) return false;
  if (ctagsAvailable === false) return false;
  try {
    const result = await execFileAsync("ctags", [
      "--output-format=json",
      "--fields=+nKS",
      "--sort=no",
      "--exclude=.git",
      "--exclude=.jevio",
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=build",
      "-R",
      ".",
    ], { cwd: workspace, maxBuffer: 20_000_000, windowsHide: true });
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let tag: Record<string, unknown>;
      try {
        tag = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (tag._type !== "tag" || typeof tag.name !== "string" || typeof tag.path !== "string") continue;
      const lineNumber = typeof tag.line === "number" ? tag.line : Number(tag.line);
      if (!Number.isFinite(lineNumber)) continue;
      addDefinition(index, {
        name: tag.name,
        kind: typeof tag.kind === "string" ? tag.kind : "symbol",
        path: tag.path.replace(/\\/g, "/"),
        line: lineNumber,
        scope: typeof tag.scope === "string" ? tag.scope : undefined,
        signature: typeof tag.signature === "string" ? tag.signature : undefined,
        language: typeof tag.language === "string" ? tag.language : undefined,
      });
    }
    index.backend = "ctags";
    ctagsAvailable = true;
    return true;
  } catch {
    ctagsAvailable = false;
    return false;
  }
}

export async function getSymbolIndex(workspace: string, config: CodeIndexConfig, force = false): Promise<SymbolIndex> {
  if (!config.enabled) throw new Error("Code index is disabled in jevio.config.json.");
  const key = path.resolve(workspace);
  const current = cache.get(key);
  if (!force && current?.configKey === configKey(config) && Date.now() - current.index.builtAt < config.cacheTtlMs) {
    return current.index;
  }
  const index = await buildBuiltinIndex(key, config);
  const usedCtags = config.backend !== "builtin" && await enrichWithCtags(index, key);
  if (config.backend === "ctags" && !usedCtags) {
    throw new Error("codeIndex.backend is 'ctags', but Universal Ctags is unavailable. Install it or use backend: 'auto'.");
  }
  cache.set(key, { configKey: configKey(config), index });
  return index;
}

export async function prewarmSymbolIndex(workspace: string, config: CodeIndexConfig): Promise<void> {
  if (config.enabled && config.prewarm) await getSymbolIndex(workspace, config);
}

export function invalidateSymbolIndex(workspace: string): void {
  cache.delete(path.resolve(workspace));
}

function displayDefinition(definition: SymbolDefinition): string {
  const scope = definition.scope ? ` ${definition.scope}.` : " ";
  const signature = definition.signature ? ` ${definition.signature}` : "";
  return `- ${definition.path}:${definition.line} [${definition.kind}]${scope}${definition.name}${signature}`;
}

export async function lookupSymbol(
  workspace: string,
  config: CodeIndexConfig,
  query: string,
  options: { includeImports?: boolean; maxResults?: number } = {},
): Promise<string> {
  const normalized = query.trim().split(".").at(-1)?.toLowerCase() ?? "";
  if (!normalized) throw new Error("query must not be empty");
  const index = await getSymbolIndex(workspace, config);
  const maxResults = Math.max(1, Math.min(options.maxResults ?? config.maxResults, config.maxResults));
  const exact = index.definitions.get(normalized) ?? [];
  const partial = exact.length ? [] : [...index.definitions.entries()]
    .filter(([name]) => name.includes(normalized))
    .flatMap(([, definitions]) => definitions);
  const definitions = [...exact, ...partial]
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
    .slice(0, maxResults);
  const references = options.includeImports === false
    ? []
    : (index.references.get(normalized) ?? []).slice(0, maxResults);

  const output = [
    `Symbol index: ${index.backend}; ${index.indexedFiles} files indexed.`,
    `Query: ${query}`,
    definitions.length ? "Definitions:" : "Definitions: none found.",
    ...definitions.map(displayDefinition),
  ];
  if (options.includeImports !== false) {
    output.push(references.length ? "Imports/references:" : "Imports/references: none found.");
    output.push(...references.map((reference) =>
      `- ${reference.path}:${reference.line}${reference.importedAs ? ` as ${reference.importedAs}` : ""}${reference.source ? ` | ${reference.source}` : ""}`,
    ));
  }
  return output.join("\n");
}
