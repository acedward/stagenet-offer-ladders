// Audit C5 (no leaked facade after a failed sync) and C6 (watchdog).
import { describe, expect, test } from "bun:test";

import { SessionPool } from "../src/ladder-wallet.ts";
import { checkStall } from "../src/watchdog.ts";

describe("C5 session pool", () => {
  test("a session whose sync fails is closed; N retries leak 0 facades", async () => {
    let opened = 0;
    let closed = 0;
    const pool = new SessionPool(
      new Map([["AB-01", "unused"]]),
      { network: {} as never, dustParameters: {} as never, log: () => undefined },
      0,
      async () => {
        opened += 1;
        return {
          synced: async () => {
            throw new Error("indexer down");
          },
          close: async () => {
            closed += 1;
          },
        } as never;
      },
    );
    for (let i = 0; i < 5; i++) await expect(pool.get("AB-01")).rejects.toThrow(/indexer down/);
    expect(opened).toBe(5);
    expect(closed).toBe(5);
  });
});

describe("C6 watchdog", () => {
  test("fires only after the limit without progress", () => {
    let now = 1_000_000;
    let last: number | undefined;
    const opts = { lastProgress: () => last, startedAt: now, limitMs: 600_000, now: () => now };
    now += 599_000;
    expect(checkStall(opts)).toBeUndefined();
    now += 2_000;
    expect(checkStall(opts)).toBe(601_000);
    last = now;
    expect(checkStall(opts)).toBeUndefined();
  });
});
