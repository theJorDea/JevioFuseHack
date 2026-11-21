# Web chat reload during an active run

Source: theJorDea/JevioFuseHack, [fix `dfcd533`](https://github.com/theJorDea/JevioFuseHack/commit/dfcd533a4bc9433457f1522026cf3ba556b4a361). This case covers the browser side only. Both files are exact `web/app.js` bytes from Git, not reconstructed samples.

| Edition | Commit | Git blob |
|---|---|---|
| base | `3f8adee7e8fca0e944078e15a3891331f2afb7b1` | `55ea9907c45236bf08f3faf1e6e7a5734caf2b3c` |
| gold | `dfcd533a4bc9433457f1522026cf3ba556b4a361` | `b98b52d322f3aa0a20dc4a3dce9dd8ab120a7f9f` |

`case.mjs` pins the source and probe digests. The held-out `probe.mjs` boots the complete trusted client with a minimal in-memory DOM and a fixed status/history/sessions API. It waits for startup to finish, confirms that all three routes were consumed and the server status was displayed, then checks the observable message and send-button state. Unexpected startup errors are not counted as historical failures.

| Initial page load | Base | Gold |
|---|---|---|
| Busy server, active user task absent from persisted history: display it once and disable send | FAIL: absent, send enabled | PASS |
| Idle server, existing user message: display it once and leave send enabled | PASS | PASS |

Verified locally with separate fresh Node processes (`node probe.mjs target` / `control`, current directory containing only the selected `web/app.js`). No real browser, server, timers, or provider is used; polling to completion and backend status production are not measured. The VM is a browser simulation for these trusted historical bytes, **not** containment for model patches. This is a public regression case, not a blinded model result. The shared catalog is intentionally unchanged.
