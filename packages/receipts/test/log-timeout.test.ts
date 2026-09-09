// A log that accepts the connection and never answers is worse than one that refuses: without a timeout it would
// hold a pre-committed call, and the agent behind it, forever. The client gives up after timeoutMs and reports the
// log as unreachable, so the call is withheld and the receipt says why.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { httpLog } from "../src/log-sink.ts";

describe("remote log timeout", () => {
  it("an append to a log that never answers fails after timeoutMs, with the retries the client is given", async () => {
    const stalled = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(stalled.address() as { port: number }).port}/`;
    try {
      const started = Date.now();
      await expect(httpLog(url, { timeoutMs: 300, retries: 1 }).append("leaf")).rejects.toThrow(/unreachable/);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(5000);
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }
  });
});
