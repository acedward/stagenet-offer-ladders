// The pinned coin selector contract, ported from `zswap-offerfiles-kernel` @ 67db767
// `deploy/scripts/lib/pinned-wallet.test.ts` (Apache-2.0). The module-level pin cell of
// the kernel is a per-wallet `PinController` here; its tests run on an instance, plus one
// test that two controllers are independent.
//
// The property under test: while armed, the give colour resolves to the armed coin or to
// NOTHING — never to a different coin.
import { beforeEach, describe, expect, test } from "bun:test";

import { chooseCoin } from "@midnightntwrk/wallet-sdk-capabilities";

import { createPinnedSelector, PinController, type ShieldedCoinSelection } from "../src/pinned-wallet.ts";

const WBTC = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912";
const WETH = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5";

const nonce = (marker: string) => marker.repeat(64).slice(0, 64);
const N_SMALL = nonce("1a");
const N_TARGET = nonce("2b");
const N_LARGE = nonce("3c");
const N_ABSENT = nonce("9f");
const N_WETH = nonce("4d");

const coin = (type: string, coinNonce: string, value: bigint) => ({ type, nonce: coinNonce, value, mt_index: 0n });

// Neither "first in the array" nor "smallest" coincides with the pinned coin.
const COINS = [coin(WBTC, N_SMALL, 100n), coin(WETH, N_WETH, 5n), coin(WBTC, N_LARGE, 9_000n), coin(WBTC, N_TARGET, 1_000n)];
const COST_MODEL = { inputFeeOverhead: 0n, outputFeeOverhead: 0n };

const select = (selector: ShieldedCoinSelection, type: string, amountNeeded = 1_000n) =>
  selector(COINS as never, type, amountNeeded, COST_MODEL as never);

describe("createPinnedSelector", () => {
  test("armed: returns EXACTLY the pinned coin, ignoring smaller and larger ones", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_TARGET }));
    expect((chooseCoin(COINS as never, WBTC) as { nonce: string } | undefined)?.nonce).toBe(N_SMALL); // control: the SDK default
    const picked = select(selector, WBTC);
    expect(picked?.nonce).toBe(N_TARGET);
    expect(picked?.value).toBe(1_000n);
    expect(picked).toBe(COINS[3] as never);
  });

  test("armed: nonce absent from the wallet -> undefined, never a substitute", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_ABSENT }));
    expect(select(selector, WBTC)).toBeUndefined();
  });

  test("unarmed: identical to the SDK's chooseCoin", () => {
    const selector = createPinnedSelector(() => null);
    for (const type of [WBTC, WETH, "", "ff".repeat(32)]) {
      expect(select(selector, type)).toBe(chooseCoin(COINS as never, type) as never);
    }
    expect(select(selector, WBTC)?.nonce).toBe(N_SMALL);
  });

  test("armed: a DIFFERENT token type still resolves through the default", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_TARGET }));
    expect(select(selector, WETH)).toBe(chooseCoin(COINS as never, WETH) as never);
    expect(select(selector, WETH)?.nonce).toBe(N_WETH);
    expect(select(selector, "")).toBe(chooseCoin(COINS as never, "") as never); // fee token
  });

  test("armed nonce belonging to another colour is never returned", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_WETH }));
    expect(select(selector, WBTC)).toBeUndefined();
  });

  test("the armed ref is read per call, not captured at construction", () => {
    let armed: { tokenType: string; nonce: string } | null = null;
    const selector = createPinnedSelector(() => armed);
    expect(select(selector, WBTC)?.nonce).toBe(N_SMALL);
    armed = { tokenType: WBTC, nonce: N_LARGE };
    expect(select(selector, WBTC)?.nonce).toBe(N_LARGE);
    armed = null;
    expect(select(selector, WBTC)?.nonce).toBe(N_SMALL);
  });

  test("the fallback receives all four arguments unchanged", () => {
    const seen: unknown[][] = [];
    const spy: ShieldedCoinSelection = (...args) => {
      seen.push([...args]);
      return undefined;
    };
    const selector = createPinnedSelector(() => null, spy);
    expect(select(selector, WBTC, 42n)).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(COINS);
    expect(seen[0]?.[1]).toBe(WBTC);
    expect(seen[0]?.[2]).toBe(42n);
    expect(seen[0]?.[3]).toBe(COST_MODEL);
  });

  test("armed: the fallback is never consulted for the armed colour", () => {
    let calls = 0;
    const spy: ShieldedCoinSelection = (...args) => {
      calls += 1;
      return chooseCoin(args[0], args[1]);
    };
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_ABSENT }), spy);
    expect(select(selector, WBTC)).toBeUndefined();
    expect(calls).toBe(0);
    expect(select(selector, WETH)?.nonce).toBe(N_WETH);
    expect(calls).toBe(1);
  });
});

describe("PinController (pin / unpin / isPinned per wallet)", () => {
  let pins: PinController;
  beforeEach(() => {
    pins = new PinController();
  });

  test("the controller's selector follows its armed state", () => {
    expect(pins.isPinned()).toBe(false);
    expect(select(pins.selector, WBTC)?.nonce).toBe(N_SMALL);
    pins.pin(WBTC, N_TARGET);
    expect(pins.isPinned()).toBe(true);
    expect(pins.pinnedCoin()).toEqual({ tokenType: WBTC, nonce: N_TARGET });
    expect(select(pins.selector, WBTC)?.nonce).toBe(N_TARGET);
    expect(select(pins.selector, WETH)?.nonce).toBe(N_WETH);
    pins.unpin();
    expect(pins.isPinned()).toBe(false);
    expect(pins.pinnedCoin()).toBeNull();
    expect(select(pins.selector, WBTC)?.nonce).toBe(N_SMALL);
  });

  test("pin() while armed throws and leaves the original ref in place", () => {
    pins.pin(WBTC, N_TARGET);
    expect(() => pins.pin(WBTC, N_LARGE)).toThrow(/already pinned/);
    expect(pins.pinnedCoin()).toEqual({ tokenType: WBTC, nonce: N_TARGET });
    expect(select(pins.selector, WBTC)?.nonce).toBe(N_TARGET);
  });

  test("unpin() is idempotent, so it is safe in a finally", () => {
    pins.unpin();
    pins.unpin();
    expect(pins.isPinned()).toBe(false);
  });

  test("pin() normalises 0x prefixes and upper case", () => {
    pins.pin(`0X${WBTC.toUpperCase()}`, `0x${N_TARGET.toUpperCase()}`);
    expect(pins.pinnedCoin()).toEqual({ tokenType: WBTC, nonce: N_TARGET });
    expect(select(pins.selector, WBTC)?.nonce).toBe(N_TARGET);
  });

  test("pin() rejects malformed colours and nonces", () => {
    expect(() => pins.pin("not-hex", N_TARGET)).toThrow(/tokenType/);
    expect(() => pins.pin(WBTC, "abc")).toThrow(/nonce/);
    expect(() => pins.pin(WBTC, "")).toThrow(/nonce/);
    expect(pins.isPinned()).toBe(false);
  });

  test("withPinnedCoin unpins on success and on throw", async () => {
    const result = await pins.withPinnedCoin(WBTC, N_TARGET, async () => {
      expect(select(pins.selector, WBTC)?.nonce).toBe(N_TARGET);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(pins.isPinned()).toBe(false);
    await expect(
      pins.withPinnedCoin(WBTC, N_TARGET, async () => {
        expect(pins.isPinned()).toBe(true);
        throw new Error("build failed");
      }),
    ).rejects.toThrow("build failed");
    expect(pins.isPinned()).toBe(false);
  });

  test("two wallets' controllers are independent (wallet-per-slot)", () => {
    const other = new PinController();
    pins.pin(WBTC, N_TARGET);
    expect(other.isPinned()).toBe(false);
    expect(select(other.selector, WBTC)?.nonce).toBe(N_SMALL);
    other.pin(WBTC, N_LARGE);
    expect(select(pins.selector, WBTC)?.nonce).toBe(N_TARGET);
    expect(select(other.selector, WBTC)?.nonce).toBe(N_LARGE);
  });
});
