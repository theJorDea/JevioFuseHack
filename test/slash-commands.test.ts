import assert from "node:assert/strict";
import test from "node:test";
import {
  findSlashCommands,
  formatInteractiveHelp,
  getPaletteItems,
  getPrimaryCommands,
  isExactSlashCommand,
  resolveSlashCommand,
} from "../src/slash-commands.ts";

test("slash command matching completes command prefixes", () => {
  assert.deepEqual(findSlashCommands("/ne").map((command) => command.name), ["new"]);
  assert.deepEqual(findSlashCommands("/or").map((command) => command.name), ["orchestrate"]);
  assert.deepEqual(findSlashCommands("/dr").map((command) => command.name), ["dream"]);
  assert.deepEqual(findSlashCommands("/ka").map((command) => command.name), ["kairos"]);
  assert.ok(findSlashCommands("/pl").map((command) => command.name).includes("plan"));
  assert.ok(findSlashCommands("/mo").map((command) => command.name).includes("models"));
});

test("aliases resolve to the primary command", () => {
  assert.equal(resolveSlashCommand("/model")?.name, "models");
  assert.equal(resolveSlashCommand("/session")?.name, "sessions");
  assert.equal(resolveSlashCommand("/rename")?.name, "title");
  assert.equal(resolveSlashCommand("/quit")?.name, "exit");
  assert.equal(resolveSlashCommand("/reset")?.name, "new");
  assert.equal(resolveSlashCommand("/h")?.name, "help");
});

test("exact slash commands are identified for immediate submit", () => {
  assert.equal(isExactSlashCommand("/exit"), true);
  assert.equal(isExactSlashCommand("/dream"), true);
  assert.equal(isExactSlashCommand("/plan"), true);
  assert.equal(isExactSlashCommand("/kairos"), true);
  assert.equal(isExactSlashCommand("/models"), true);
  assert.equal(isExactSlashCommand("/model"), true); // alias
  assert.equal(isExactSlashCommand("/yolo"), true);
  assert.equal(isExactSlashCommand("/provider cloud"), false);
});

test("palette hides clear and pure-noise, keeps primary commands", () => {
  const names = getPaletteItems().map((item) => item.value);
  assert.ok(names.includes("/new"));
  assert.ok(names.includes("/roles"));
  assert.ok(names.includes("/models"));
  assert.ok(!names.includes("/clear")); // hidden: screen wipe only
  assert.ok(!names.includes("/model")); // alias of /models
  assert.ok(getPrimaryCommands().every((command) => command.palette !== false));
});

test("interactive help is grouped and short", () => {
  const help = formatInteractiveHelp();
  assert.match(help, /Сессия:/);
  assert.match(help, /Модели:/);
  assert.match(help, /\/roles/);
  assert.match(help, /\/new — новая сессия/);
  assert.ok(!help.includes("/model ")); // no alias spam
  assert.ok(help.split("\n").length < 55);
});
