# LM Studio endpoint tool-mode default

Historical Jevio fix [d4f0f09](https://github.com/theJorDea/JevioFuseHack/commit/d4f0f09185c0fc893d0378a7f763e50e03ba0f93), parent `c4fb1023d9da0a7ae6c1a91bb9b3000b9a8ce386`. That commit added a config regression test and changed the merge step to recognize both the provider name and local port. This case isolates the latter: the user can have chosen any provider name.

Exact Git blobs of **all** of `src/config.ts`: base `8697193a309605a2468a4ae6b22ab9989d0a3782`, gold `2f84262e8508c88a6018efdf40ed4db4b5aa0874`. `git cat-file blob <id>` reproduces the corresponding fixture bytes. SHA-256 pins for both and for the held-out probe are in `case.mjs`.

Target: loading a temporary project config for an aliased loopback LM Studio endpoint used to leave `toolMode` absent; the fixed merge chooses `text`. Control: an explicitly selected `native` mode still takes precedence, and an unrelated endpoint gets no override. Each check uses a new temporary snapshot and held-out config. `loadConfig` reads only fixture-owned paths with a cleaned environment; no connection to LM Studio or a model is made. This is a config-loading check, not a model-generation or stream-transport test.

Measured base target FAIL/control PASS; gold target PASS/control PASS. For future pure-function evaluation the isolated configuration merge would need extraction and a URL implementation; the historical reference module itself uses Node filesystem APIs. This public case is for trusted qualification only.
