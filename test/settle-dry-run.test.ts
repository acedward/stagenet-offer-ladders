// 00058 FR-007: `offers:settle --dry-run` balances, signs and finalizes the taker's
// settlement, reports its fee and size, releases the wallet's reservation, and NEVER submits.
// A fake session records the calls; `submitTransaction` fails the test if it is reached.
import { describe, expect, test } from "bun:test";

import { parseFlags, settleArgs, switchFlag } from "../src/cli.ts";
import { dryRunDecoded, type SettleSession } from "../src/settle.ts";

const NONCE = "ab".repeat(32);
const COLOUR = "e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d";

describe("--dry-run flag", () => {
  test("a bare switch, anywhere; absent means a real settle; a value is refused", () => {
    expect(settleArgs(parseFlags(["--slot", "T13A-01", "--pay-with", NONCE, "--dry-run"]))).toEqual({ slot: "T13A-01", payWith: NONCE, dryRun: true });
    expect(settleArgs(parseFlags(["--dry-run", "--slot", "T13A-01", "--pay-with", NONCE])).dryRun).toBe(true);
    expect(settleArgs(parseFlags(["--slot", "T13A-01", "--pay-with", NONCE])).dryRun).toBe(false);
    expect(settleArgs(parseFlags(["--slot", "T13A-01", "--pay-with", NONCE, "--ladder-file", "ladders/stagenet.books.json", "--offer-id", "c".repeat(64)]))).toEqual({
      slot: "T13A-01",
      payWith: NONCE,
      dryRun: false,
      ladderFile: "ladders/stagenet.books.json",
      offerId: "c".repeat(64),
    });
    expect(() => settleArgs(parseFlags(["--slot", "T13A-01", "--pay-with", NONCE, "--dry-run", "yes"]))).toThrow(/takes no value/);
    expect(() => settleArgs(parseFlags(["--slot", "T13A-01", "--dry-run"]))).toThrow(/--pay-with/);
    expect(() => switchFlag(parseFlags(["--dry-run=false"]), "dry-run")).toThrow(/takes no value/);
  });
});

const fakeSession = (options: { fee?: bigint | Error; revert?: Error } = {}) => {
  const calls: string[] = [];
  const finalized = {
    identifiers: () => ["00feedface"],
    serialize: () => new Uint8Array(25_431),
    fees: () => {
      if (options.fee instanceof Error) throw options.fee;
      return options.fee ?? 380_122_000_000_000n;
    },
    // Two settlement inputs: the offer's coin and the taker's pinned coin.
    guaranteedOffer: { inputs: [{ nullifier: "11".repeat(32) }, { nullifier: "22".repeat(32) }] },
  };
  const session: SettleSession = {
    pins: {
      async withPinnedCoin<T>(colour: string, nonce: string, fn: () => Promise<T>): Promise<T> {
        calls.push(`pin ${colour.slice(0, 8)} ${nonce.slice(0, 8)}`);
        try {
          return await fn();
        } finally {
          calls.push("unpin");
        }
      },
    },
    secretKeys: { fake: true },
    signData: async () => "signature",
    facade: {
      balanceFinalizedTransaction: (async (_tx: unknown, _keys: unknown, options: { ttl: Date }) => {
        calls.push(`balance ttl>${options.ttl.getTime() > Date.now() ? "now" : "PAST"}`);
        return "recipe";
      }) as never,
      signRecipe: (async (_recipe: unknown, sign: (data: Uint8Array) => Promise<unknown>) => {
        calls.push("sign");
        await sign(new Uint8Array([1]));
        return "signed";
      }) as never,
      finalizeRecipe: (async () => {
        calls.push("finalize");
        return finalized;
      }) as never,
      submitTransaction: (async () => {
        calls.push("SUBMIT");
        throw new Error("a dry run must never submit");
      }) as never,
      revert: (async () => {
        calls.push("revert");
        if (options.revert) throw options.revert;
      }) as never,
    },
  };
  return { session, calls };
};

const offerTx = { guaranteedOffer: { inputs: [{ nullifier: "11".repeat(32) }] } };

describe("dry run (no submit)", () => {
  test("balances with the pinned coin, finalizes, reports fee and size, releases, and does not submit", async () => {
    const { session, calls } = fakeSession();
    const lines: string[] = [];
    const result = await dryRunDecoded({
      session,
      offerId: "c".repeat(64),
      offerTx,
      payColour: COLOUR,
      payWithNonce: NONCE,
      feeParameters: {} as never,
      log: (line) => lines.push(line),
    });
    expect(calls).toEqual([`pin ${COLOUR.slice(0, 8)} ${NONCE.slice(0, 8)}`, "balance ttl>now", "unpin", "sign", "finalize", "revert"]);
    expect(calls).not.toContain("SUBMIT");
    expect(result).toMatchObject({
      dryRun: true,
      submitted: false,
      offerId: "c".repeat(64),
      offerNullifiers: ["11".repeat(32)],
      settlementNullifiers: ["11".repeat(32), "22".repeat(32)],
      txId: "00feedface",
      bytes: 25_431,
      feeSpecks: "380122000000000",
      feeDust: "0.380122",
      released: true,
    });
    expect(result.balanceMs).toBeGreaterThanOrEqual(0);
    expect(result.finalizeMs).toBeGreaterThanOrEqual(0);
    expect(lines.join("\n")).toMatch(/DRY RUN/);
    expect(lines.join("\n")).toMatch(/NOT submitted/);
  });

  test("without ledger parameters the fee is null; a fee error is reported, not thrown", async () => {
    const noParams = await dryRunDecoded({ session: fakeSession().session, offerId: "c".repeat(64), offerTx, payColour: COLOUR, payWithNonce: NONCE, log: () => undefined });
    expect(noParams).toMatchObject({ feeSpecks: null, feeDust: null, released: true });
    const failing = await dryRunDecoded({
      session: fakeSession({ fee: new Error("no fee") }).session,
      offerId: "c".repeat(64),
      offerTx,
      payColour: COLOUR,
      payWithNonce: NONCE,
      feeParameters: {} as never,
      log: () => undefined,
    });
    expect(failing).toMatchObject({ feeSpecks: null, feeError: "no fee", submitted: false });
  });

  test("a failed release is reported (released: false) and still nothing is submitted", async () => {
    const { session, calls } = fakeSession({ revert: new Error("revert failed") });
    const result = await dryRunDecoded({ session, offerId: "c".repeat(64), offerTx, payColour: COLOUR, payWithNonce: NONCE, log: () => undefined });
    expect(result.released).toBe(false);
    expect(result.submitted).toBe(false);
    expect(calls).not.toContain("SUBMIT");
  });
});
