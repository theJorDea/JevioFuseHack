import assert from "node:assert/strict";
import test from "node:test";
import {
  completeSlashArguments,
  findSlashCommands,
  formatInteractiveHelp,
  formatSubcommandHelp,
  getAutocompleteSlashCommands,
  getPaletteItems,
  getPrimaryCommands,
  getSubcommands,
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
  assert.match(help, /\/memory show\|add/);
  assert.ok(!help.includes("/model ")); // no alias spam
  assert.ok(help.split("\n").length < 65);
});

test("memory and related commands expose subcommand completions", () => {
  const mem = getSubcommands("memory").map((item) => item.name);
  assert.ok(mem.includes("add"));
  assert.ok(mem.includes("status"));
  assert.ok(mem.includes("explain"));
  assert.ok(mem.includes("show"));

  const adds = completeSlashArguments("memory", "ad");
  assert.deepEqual(adds.map((item) => item.label), ["add"]);
  assert.ok(adds[0].value.startsWith("add"));

  // After subcommand + space, free-text args are not forced from the list.
  assert.deepEqual(completeSlashArguments("memory", "add foo"), []);

  const help = formatSubcommandHelp("memory");
  assert.match(help, /\/memory add/);
  assert.match(help, /\/memory status/);

  const auto = getAutocompleteSlashCommands().find((command) => command.name === "memory");
  assert.ok(auto?.getArgumentCompletions);
  const items = auto!.getArgumentCompletions!("st");
  assert.ok(items?.some((item) => item.label === "status"));
});
