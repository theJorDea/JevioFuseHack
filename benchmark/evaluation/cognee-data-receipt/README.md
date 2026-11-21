# Historical qualification case: missing Cognee data receipt

**Task (`cognee-data-receipt`)**: A successful background remember request can return only a dataset ID. Recover the addressable data ID for the uploaded record. Do not change how already-addressable receipts work. The service can be emulated; no account, credentials, internet or model needed.

**Provenance.** This is a regression replay of a real landed [fix](https://github.com/theJorDea/JevioFuseHack/commit/3f1bd70b09b0ac6301b9fdfea37ec88197707df5), not a synthetic bug or evidence of a separately numbered closed issue. Parent: `78d49c472449944ede260b113e621078e4317651`. The fix itself adds a regression test for a dataset-only response; the mock service and probes here are independent fixture code, not live Cognee evidence.

| Vendored bytes | Historical relative path | Git blob ID |
|---|---|---|
| `base-memory.ts.fixture` | `src/memory.ts`, parent | `5726afc150a23ce75c319c79640518797e70e949` |
| `gold-memory.ts.fixture` | `src/memory.ts`, fix | `ac583a48d964724cd51bb48d4d5e5ba1e293d587` |
| `project-identity.ts.fixture` | `src/project-identity.ts`, identical on both | `8439fccd5f94b7ed515ff209b711da8b153c73e2` |

Each is the unmodified `git cat-file blob <id>` payload from the MIT-licensed project. Vendoring means the runner works on shallow checkouts and never needs to fetch history. These are the only two runtime source files per snapshot; type-only imports are stripped by Node. SHA-256 allowlist is in `scripts/eval-qualify.mjs`. The manifest fingerprint is SHA-256 over the JSON encoding of the ordered `[relativePath, contentSha256]` pairs. `snapshotHash` identifies the **base** (not the oracle or runtime).

**Run** `node scripts/eval-qualify.mjs` with the project's supported Node version; `node --test test/eval-qualify.test.ts` verifies both the matrix and tamper refusal. Each revision gets a fresh disposable directory with only the two selected files in `snapshot/src/`, no `.git`, history, package dependencies, future source, or tests. The held-out trusted probe is staged in a sibling directory. Each check runs in a fresh Node process with an allowlisted environment (only `SystemRoot` on Windows), an injected in-memory fetcher, and a deadline. Infrastructure failures are errors, not red test outcomes.

- **Fail → pass**: a successful dataset-only response lacks a data ID on the parent. The fix resolves the entry through the mocked dataset endpoints and returns the expected ID.
- **Pass → pass**: an already-addressable receipt returns its original ID with no additional calls in either version.

**Boundary:** directory separation is for benchmark hygiene, **not containment**. These processes run with host user permissions. Only the two pinned historical revisions and the reviewed probe are executable. There is no candidate patch or arbitrary command input. Do not point this at untrusted model output. Gold and probes are visible in this public fixture; for a future model evaluation provide only the task and base snapshot, never the fixture repository, and use real isolation before executing generated code. A qualified case does not grade any model or establish live service compatibility.
