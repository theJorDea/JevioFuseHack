import assert from "node:assert/strict";
import test from "node:test";
import { findSlashCommands, isExactSlashCommand } from "../src/slash-commands.ts";

test("slash command matching completes command prefixes", () => {
  assert.deepEqual(findSlashCommands("/ne").map((command) => command.name), ["new"]);
  assert.deepEqual(findSlashCommands("/or").map((command) => command.name), ["orchestrate"]);
});

test("exact slash commands are identified for immediate submit", () => {
  assert.equal(isExactSlashCommand("/exit"), true);
  assert.equal(isExactSlashCommand("/provider cloud"), false);
});
