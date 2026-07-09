import assert from "node:assert/strict";
import test from "node:test";
import { findSlashCommands } from "../src/slash-commands.ts";

test("slash command matching completes command prefixes", () => {
  assert.deepEqual(findSlashCommands("/ne").map((command) => command.name), ["new"]);
  assert.deepEqual(findSlashCommands("/or").map((command) => command.name), ["orchestrate"]);
});
