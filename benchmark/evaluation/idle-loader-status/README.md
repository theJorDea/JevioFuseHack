# Idle loader status

In the parent of [9213644](https://github.com/theJorDea/JevioFuseHack/commit/92136446dd8b51bcdceacbdd834facd084ae2959), the loader and the separate status line both said `Готово` at startup. After a normal submit, stopping the animation and clearing the loader message still left a spinner glyph. The fix reserves the spinner for work in progress.

Both fixtures are complete, byte-for-byte Git blobs for `src/interactive-tui.ts`, without checkout filters. Reconstruct with `git cat-file blob <blob>` and binary-safe output redirection.

| Snapshot | Commit | Blob |
| --- | --- | --- |
| Base | `e8e73a7e3b2ebf13f89ba446671018ab02e1c16c` | `ea5d1521117aeeb8ecd04f6fc90db87c68049620` |
| Gold | `92136446dd8b51bcdceacbdd834facd084ae2959` | `5dd92dc6e7f3f91213f6933fe61fbb754154cfb5` |

For each snapshot and each mode, copy the fixture to `src/interactive-tui.ts` under a fresh working directory and run `node /absolute/path/to/probe.mjs target` or `control` there (Node 24). The JSON result is the verdict. Expected base: `FAIL`/`PASS`; gold: `PASS`/`PASS`.

The target observes loader text, animation state and the separate status at startup and after a successful submission. The control samples the thinking indicator while that same submission is pending. The probe verifies the whole file against a two-blob SHA-256 allowlist before extracting the historical loader initialization, `run`, and `handleSubmit`. Component doubles model the loader's first frame and animation state without a terminal or timer. No project imports, candidate code, picker actions, or network calls are involved. This qualifies historical snapshots only; it is not a candidate-code runner. Expose only the task and base source to a model.
