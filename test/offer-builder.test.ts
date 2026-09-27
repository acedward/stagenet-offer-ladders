// Offer builder: the exact-coin assertion, revert on mismatch, pin release, nullifier
// collection. The SDK is faked (see helpers.ts); the pin selector and the builder are real.
import { describe, expect, test } from "bun:test";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import { assertExactCoin, buildPinnedOffer, collectNullifiers, countFallibleInputs, WrongInputError } from "../src/offer-builder.ts";
import { blobSha256 } from "../src/outbox.ts";
import { COLOUR_A, COLOUR_B, coin, decodeFakeOffer, FakeWallet } from "./helpers.ts";

const NOW = new Date("2026-09-26T12:00:00.000Z");

describe("collectNullifiers / countFallibleInputs (vendored from the kernel validator)", () => {
  test("guaranteed + fallible segments, inputs + transients, bytes or hex", () => {
    const tx = {
      guaranteedOffer: { inputs: [{ nullifier: "0xAB" }], transients: [{ nullifier: new Uint8Array([1, 2]) }] },
      fallibleOffer: new Map([[1, { inputs: [{ nullifier: "cd" }] }]]),
    };
    expect(collectNullifiers(tx)).toEqual(["ab", "0102", "cd"]);
    expect(countFallibleInputs(tx)).toBe(1);
    expect(collectNullifiers({})).toEqual([]);
    expect(countFallibleInputs({ guaranteedOffer: { inputs: [] } })).toBe(0);
  });

  test("assertExactCoin: exactly one input, the pinned coin's, nothing fallible", () => {
    const c = coin(COLOUR_A, "x", 100n);
    expect(() => assertExactCoin([c.nullifier], 0, c)).not.toThrow();
    expect(() => assertExactCoin([c.nullifier.toUpperCase()], 0, c)).not.toThrow();
    expect(() => assertExactCoin([], 0, c)).toThrow(WrongInputError);
    expect(() => assertExactCoin([c.nullifier, c.nullifier], 0, c)).toThrow(WrongInputError);
    expect(() => assertExactCoin(["ff".repeat(32)], 0, c)).toThrow(WrongInputError);
    expect(() => assertExactCoin([c.nullifier], 1, c)).toThrow(/fallible/);
  });
});

describe("buildPinnedOffer", () => {
  test("pins the named coin (not the smallest), encodes, and releases the pin", async () => {
    const small = coin(COLOUR_A, "small", 100_000_000n);
    const target = coin(COLOUR_A, "target", 100_000_000n);
    const big = coin(COLOUR_A, "big", 1_000_000_000n);
    const wallet = new FakeWallet("funding", [big, small, target]);
    const built = await buildPinnedOffer(wallet.offerWallet(), {
      giveColour: COLOUR_A,
      giveAmount: 100_000_000n,
      coin: target,
      wantColour: COLOUR_B,
      wantAmount: 80_000_000n,
      ttlMs: 3_600_000,
      now: NOW,
    });
    expect(wallet.pins.isPinned()).toBe(false);
    expect(built.nullifiers).toEqual([target.nullifier]);
    expect(built.blob.startsWith("swapoffer1")).toBe(true);
    expect(built.offerId).toBe(OfferFiles.offerId(OfferFiles.decode(built.blob)));
    expect(built.blobSha256).toBe(blobSha256(built.blob));
    expect(built.expiresAt.toISOString()).toBe("2026-09-26T13:00:00.000Z");
    const payload = decodeFakeOffer(built.blob);
    expect(payload).toMatchObject({ nonce: target.nonce, giveAmount: "100000000", wantAmount: "80000000", want: COLOUR_B, ttl: "2026-09-26T13:00:00.000Z" });
    expect(wallet.reverts).toBe(0);
  });

  test("an SDK that ignores the pin is caught: reverted, WrongInputError, nothing returned", async () => {
    const small = coin(COLOUR_A, "small", 100_000_000n);
    const target = coin(COLOUR_A, "target", 200_000_000n);
    const wallet = new FakeWallet("funding", [small, target]);
    wallet.ignorePin = true;
    await expect(
      buildPinnedOffer(wallet.offerWallet(), {
        giveColour: COLOUR_A,
        giveAmount: 100_000_000n,
        coin: target,
        wantColour: COLOUR_B,
        wantAmount: 1n,
        ttlMs: 60_000,
        now: NOW,
      }),
    ).rejects.toThrow(WrongInputError);
    expect(wallet.reverts).toBe(1);
    expect(wallet.pins.isPinned()).toBe(false);
  });

  test("a pinned coin that is not in the wallet fails the build (no substitute)", async () => {
    const other = coin(COLOUR_A, "other", 100_000_000n);
    const gone = coin(COLOUR_A, "gone", 100_000_000n);
    const wallet = new FakeWallet("funding", [other]);
    await expect(
      buildPinnedOffer(wallet.offerWallet(), { giveColour: COLOUR_A, giveAmount: 100_000_000n, coin: gone, wantColour: COLOUR_B, wantAmount: 1n, ttlMs: 60_000, now: NOW }),
    ).rejects.toThrow(/InsufficientFunds/);
    expect(wallet.pins.isPinned()).toBe(false);
  });

  test("wrong colour or too small a coin is refused before touching the wallet", async () => {
    const wallet = new FakeWallet("funding", []);
    const b = coin(COLOUR_B, "b", 100_000_000n);
    await expect(
      buildPinnedOffer(wallet.offerWallet(), { giveColour: COLOUR_A, giveAmount: 1n, coin: b, wantColour: COLOUR_B, wantAmount: 1n, ttlMs: 1, now: NOW }),
    ).rejects.toThrow(/not the give colour/);
    const tiny = coin(COLOUR_A, "tiny", 5n);
    await expect(
      buildPinnedOffer(wallet.offerWallet(), { giveColour: COLOUR_A, giveAmount: 10n, coin: tiny, wantColour: COLOUR_B, wantAmount: 1n, ttlMs: 1, now: NOW }),
    ).rejects.toThrow(/below the give amount/);
  });

  test("a change-returning offer (1000-token coin, give 100) still has one input", async () => {
    const inventory = coin(COLOUR_A, "inventory", 1_000_000_000n);
    const wallet = new FakeWallet("AB-01", [inventory]);
    const built = await buildPinnedOffer(wallet.offerWallet(), {
      giveColour: COLOUR_A,
      giveAmount: 100_000_000n,
      coin: inventory,
      wantColour: COLOUR_B,
      wantAmount: 80_000_000n,
      ttlMs: 60_000,
      now: NOW,
    });
    expect(built.nullifiers).toEqual([inventory.nullifier]);
  });
});
