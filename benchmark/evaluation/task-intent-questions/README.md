# Task intent: questions about existing behavior

The earlier `isImplementationRequest` treated an implementation verb mentioned in a question as a request for edits. The gold revision adds analysis-only cues, and its `test/task-intent.test.ts` adds the historical regression test `does not treat Q&A / analysis as implementation`. This probe uses a different question and pairs it with a direct instruction about the same action and object.

| Snapshot | JevioFuseHack commit | Git blob, `src/task-intent.ts` | Target | Control |
| --- | --- | --- | --- | --- |
| Base (parent) | `6a6fab922fb2b1fa5ef0e485063858558a390e22` | `707ce0712daf388e8e30bacca78858f92bdbd9a1` | FAIL | PASS |
| Gold | `d3d6198f3ee2b9691020d75f735ccf6f30a6dd1b` | `7dd2222a9f6f728ba5344685016b7453c7f23280` | PASS | PASS |

The fixtures are the unmodified Git blobs, not excerpts. Verify the SHA-256 values in `case.mjs`, copy the selected fixture to `src/task-intent.ts` in an empty snapshot directory, and run `node <absolute-path-to-probe.mjs> target` and `node <absolute-path-to-probe.mjs> control` with that directory as cwd. Use Node with native TypeScript stripping (verified on v24.14.1). Only the trusted historical module executes; its sole import is type-only. No generated candidate code, dependencies, model, or network is used.

Scope: two English utterances with no conversation history. This isolates the classifier's boolean result, not downstream routing, actual edits, other languages, or the whole historical commit. Passing does not establish general natural-language accuracy.
