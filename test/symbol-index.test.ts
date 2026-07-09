import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { invalidateSymbolIndex, lookupSymbol } from "../src/symbol-index.ts";

async function workspace(t: { after(callback: () => unknown): void }): Promise<string> {
  const directory = path.join(process.cwd(), `.tmp-test-symbols-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("builtin symbol index finds definitions, methods, and import aliases", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), `export class AuthService {
  validateToken(token: string): boolean {
    return token.length > 0;
  }
}

export function validateToken(token: string): boolean {
  return token.length > 0;
}
`);
  await writeFile(path.join(root, "src", "api.ts"), `import { validateToken as checkToken } from "./auth";

export const authorize = (token: string) => checkToken(token);
`);

  const config = structuredClone(DEFAULT_CONFIG.codeIndex);
  config.backend = "builtin";
  const output = await lookupSymbol(root, config, "authService.validateToken");
  assert.match(output, /src[\\/]auth\.ts:2 \[method\] AuthService\.validateToken/);

  const imported = await lookupSymbol(root, config, "validateToken");
  assert.match(imported, /src[\\/]api\.ts:1 as checkToken/);
  assert.match(imported, /src[\\/]auth\.ts:7 \[function\]/);
});

test("symbol index rebuilds after explicit invalidation", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG.codeIndex);
  config.backend = "builtin";
  await writeFile(path.join(root, "src", "first.ts"), "export const firstSymbol = 1;\n");
  assert.match(await lookupSymbol(root, config, "firstSymbol"), /first\.ts:1/);

  await writeFile(path.join(root, "src", "second.ts"), "export const secondSymbol = 2;\n");
  assert.match(await lookupSymbol(root, config, "secondSymbol"), /Definitions: none found/);
  invalidateSymbolIndex(root);
  assert.match(await lookupSymbol(root, config, "secondSymbol"), /second\.ts:1/);
});
