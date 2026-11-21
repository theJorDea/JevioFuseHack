# Provider stream recovery: historical qualification case

The case isolates the chat-completions provider change in Jevio fix `5bff745`. It tests termination while reading a response body, not connection establishment, CLI behavior, or a live LM Studio server.

Each fixture is the full, unmodified `src/provider/openai-compatible.ts` Git blob from this MIT-licensed repository:

| Fixture | Commit | Blob |
| --- | --- | --- |
| `base-provider.ts.fixture` | `84e310572f160608946308205e68828e8d9576ce` (parent) | `e1a03268ba438381ee449f67c263fe8f5583d608` |
| `gold-provider.ts.fixture` | `5bff745af9654fa4ae07d1e023d83449d09df1aa` (fix) | `d8068846066e5c60f64e2c6aa29103f00e1b85f3` |

Verify fixture and probe SHA-256 against `case.mjs`. For each snapshot and check, copy just the fixture to its descriptor path in a fresh directory. From there run `node /path/to/held-out/probe.mjs target` or `control` using Node 22.19+ without preload hooks. Fetch is mocked before the verified historical source is type-stripped and loaded. No packages, Git history, credentials, network, or generated candidate code are used.

The target mock returns a response whose body errors with `terminated`. Base propagates that exact error after one streaming request (`"FAIL"`); gold makes one otherwise identical non-streaming request and returns its content (`"PASS"`). The control sends a healthy SSE response: both revisions must deliver its text delta and final content without retrying (`"PASS"`). Unexpected observations throw rather than counting as historical failure.

This is a trusted two-revision replay, not a candidate-code runner. Give a solver only the task and base source; keep the probe, descriptor, gold and history outside its workspace.
