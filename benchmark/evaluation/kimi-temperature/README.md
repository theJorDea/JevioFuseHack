# Kimi provider temperature: historical qualification case

This fixture replays the outgoing chat request in JevioFuseHack commit `c0ae5d5c89f7fd84062461ae488ca1b87ebc0e73`. It covers the provider only, not the CLI or saved role configuration changed in the same commit. It does not test the live Moonshot API.

Both snapshots contain only `src/provider/openai-compatible.ts`. Each fixture is the exact LF payload of `git cat-file blob <blob>` from this MIT-licensed repository; no historical tests or dependencies are staged.

| Fixture | Commit | Git blob |
| --- | --- | --- |
| `base-provider.ts.fixture` | `df8e9c97e7bb1524796b6d9401ab5986565192bb` (parent) | `698f7b7a6bcf8f8d83ddeaa4b415f28fc47ceb81` |
| `gold-provider.ts.fixture` | `c0ae5d5c89f7fd84062461ae488ca1b87ebc0e73` (fix) | `fe1572c2d32f34bdba8d54be3370d604b56b9e7a` |

Verify fixture and probe SHA-256 against `case.mjs` before staging. From the disposable snapshot root, run `node /path/to/held-out/probe.mjs target` or `control`, each in a fresh process using the project's supported Node (22.19+), without preload hooks. No Git checkout, packages, credentials or network are needed. The probe installs a mock fetch before loading the provider and uses Node to strip its type-only import from the verified bytes.

The mock observes the serialized temperature with an explicit request override of zero, then with only a role setting, then with neither. On base, Kimi receives the ordinary temperature sequence (`"FAIL"`); on gold all three requests send 1 (`"PASS"`). The ordinary model must retain request-over-role-over-default precedence (`"PASS"` on both). Unexpected observations, unrecognized source, and invocation errors throw rather than counting as the historical failure.

**Restrictions:** This is a trusted two-revision replay, not a candidate-code runner or sandbox. Only run the reviewed descriptor and pinned probe against these blobs; there is no patch or command input. Keep the oracle, gold, history and provenance out of any solver workspace. Give a solver only the plain task and base snapshot; these public artifacts are not secret tests or evidence of model performance.
