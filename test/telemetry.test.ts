import assert from "node:assert/strict";
import test from "node:test";
import { addTraceEvent, setTraceAttributes, withTraceSpan } from "../src/telemetry.ts";

test("telemetry helpers remain safe with the default no-op provider", async () => {
  const result = await withTraceSpan("jevio.test", { "jevio.test": true }, async () => {
    addTraceEvent("test.event", { count: 1 });
    setTraceAttributes({ "test.result": "ok" });
    return 42;
  });
  assert.equal(result, 42);
  await assert.rejects(() => withTraceSpan("jevio.failure", {}, async () => {
    throw new Error("expected failure");
  }), /expected failure/);
});
