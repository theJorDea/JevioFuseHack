# Historical task: text-tool-line-continuation

A local model could return a fenced text-protocol call containing a backslash immediately before a physical line ending inside a JSON string. The base parser silently returned no call. The target checks LF and CRLF variants and compares the decoded tool name and full arguments, including whitespace, quotes and a literal backslash. The control is the same legitimate invocation encoded as valid JSON. The `lookup` name is inert: the oracle never dispatches a tool, writes a requested file or starts an agent.

| Revision | Git blob (`src/agent.ts`) | Target | Control |
|---|---|---|---|
| Base `2f5ce1d8d3e94f66a77daa64451201d7e9026a76` | `eebbb7669a0446b6ee86d14d6f590506caa7a571` | FAIL (empty result) | PASS |
| Gold [`65e3ea4191d2dd400857b0334978aa7de8df1db0`](https://github.com/theJorDea/JevioFuseHack/commit/65e3ea4191d2dd400857b0334978aa7de8df1db0) | `8a27ea7b252231dc83cebae90684506370795d44` | PASS | PASS |

The upstream fix added a regression in `test/agent.test.ts` for line continuations. This is a parser microcase, **not** a benchmark of the full agent, execution permissions or malformed JSON in general. It is public, so prior model exposure is possible.

## Reproduce fixture bytes

From the repository root with those Git objects present, run `node benchmark/evaluation/text-tool-line-continuation/reconstruct.mjs`. This reads each blob with `git cat-file blob`, copies the contiguous fallback parser from `export function parseFallbackToolCalls(` (base) or `function repairMalformedJsonLineContinuations(` (gold) through its closing brace and LF, immediately before `export function pruneOldToolResults(`. No generated wrapper, imports, replacements or line-ending conversion. `ToolCall` exists only as a TypeScript annotation and is stripped by Node. Compare SHA-256 to `case.mjs`. The qualification runner does not need Git or this reconstruction script.

For each edition stage **only** the descriptor-pinned source as `snapshot/src/agent.ts` under an ESM package boundary. Launch `node /absolute/path/to/probe.mjs target` and `... control` separately with cwd `snapshot`. The probe refuses unrecognized source bytes; only a known historical failure emits `"FAIL"`. Unexpected payloads, exceptions or mismatched line-ending behavior abort qualification. This is trusted historical qualification, not a sandbox for candidate patches.
