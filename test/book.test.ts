// 00057: stock/USDC books — book ladders (side, base/quote, explicit prices), directional
// rounding, no crossing, the slot → wallet mapping, bridged colours, the book summary, and
// that the 00053 ladder files still parse to the same slots.
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import { bookSummary, formatUnits } from "../src/book.ts";
import { bridgedColour, checkBridgedColours } from "../src/bridge.ts";
import type { SlotRecord } from "../src/journal.ts";
import { buildSlots, mulCeil, parseLadderFile } from "../src/ladder.ts";
import { withinLevel } from "../src/verify.ts";

const VAULT = "7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637";
/** AA 00037's recorded colours (deployments/stagenet-vault.json, bridgedTokens). */
const RECORDED = [
  { symbol: "wStkA", erc20: "0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52", colour: "5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02" },
  { symbol: "wStkB", erc20: "0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B", colour: "e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588" },
  { symbol: "wStkC", erc20: "0x70c5c1978e5d428fa5C82111980e1aF0A64a270D", colour: "db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9" },
] as const;
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const BOOK_FILE = "ladders/stagenet.usdc.json";
const rawBook = (): Record<string, any> => JSON.parse(readFileSync(BOOK_FILE, "utf8"));

/**
 * The committed book with its wUSDC colour usable: the recorded colour once AA 00037 P7 has
 * written it into the file, until then the vault derivation (in memory only).
 */
const usableBook = () => {
  const raw = rawBook();
  const usdc = raw.tokens.wUSDC;
  if (String(usdc.colour).startsWith("PENDING")) usdc.colour = bridgedColour(usdc.bridge);
  return parseLadderFile(raw);
};

describe("the book file (spec table)", () => {
  test("20 offers: exact raw amounts, sides, prices and makers", () => {
    const slots = buildSlots(usableBook());
    expect(slots).toHaveLength(20);
    const view = (ladder: string) => slots.filter((s) => s.ladder === ladder);
    const ASK_WANTS = [1_040_000n, 1_080_000n, 1_120_000n, 1_160_000n, 1_200_000n];
    // 1,000,000 / price rounded UP (the maker never pays more than its level; questions-file Q8).
    const BID_WANTS = [104_166_667n, 108_695_653n, 113_636_364n, 119_047_620n, 125_000_000n];
    for (const [ladder, base, side, wallets] of [
      ["AASK", "wStkA", "ask", ["AB-01", "AB-02", "AB-03", "AB-04", "AB-05"]],
      ["ABID", "wStkA", "bid", ["AB-06", "AB-07", "AB-08", "AB-09", "AB-10"]],
      ["BASK", "wStkB", "ask", ["BC-01", "BC-02", "BC-03", "BC-04", "BC-05"]],
      ["BBID", "wStkB", "bid", ["BC-06", "BC-07", "BC-08", "BC-09", "BC-10"]],
    ] as const) {
      const ladderSlots = view(ladder);
      expect(ladderSlots.map((s) => s.id)).toEqual([1, 2, 3, 4, 5].map((n) => `${ladder}-0${n}`));
      expect(ladderSlots.map((s) => s.walletId)).toEqual([...wallets]);
      for (const slot of ladderSlots) {
        expect(slot.side).toBe(side);
        expect(slot.pair).toBe(`${base}/wUSDC`);
      }
      if (side === "ask") {
        expect(ladderSlots.map((s) => [s.giveSymbol, s.wantSymbol])).toEqual(Array(5).fill([base, "wUSDC"]));
        expect(ladderSlots.map((s) => s.priceText)).toEqual(["0.0104", "0.0108", "0.0112", "0.0116", "0.0120"]);
        expect(ladderSlots.map((s) => s.giveAmount)).toEqual(Array(5).fill(100_000_000n));
        expect(ladderSlots.map((s) => s.wantAmount)).toEqual(ASK_WANTS);
      } else {
        expect(ladderSlots.map((s) => [s.giveSymbol, s.wantSymbol])).toEqual(Array(5).fill(["wUSDC", base]));
        expect(ladderSlots.map((s) => s.priceText)).toEqual(["0.0096", "0.0092", "0.0088", "0.0084", "0.0080"]);
        expect(ladderSlots.map((s) => s.giveAmount)).toEqual(Array(5).fill(1_000_000n));
        expect(ladderSlots.map((s) => s.wantAmount)).toEqual(BID_WANTS);
      }
    }
  });

  test("rounding is in the maker's favour and no level crosses the other side", () => {
    const slots = buildSlots(usableBook());
    const decimals = { base: 6, quote: 6 };
    for (const slot of slots) {
      // Every offer trades at its level or better for the maker…
      expect(withinLevel(slot.side!, slot.priceText, slot.giveAmount, slot.wantAmount, decimals)).toBe(true);
      // …and one base unit less for the maker would not: the rounding is tight.
      expect(withinLevel(slot.side!, slot.priceText, slot.giveAmount, slot.wantAmount - 1n, decimals)).toBe(false);
    }
    for (const pair of ["wStkA/wUSDC", "wStkB/wUSDC"]) {
      const asks = slots.filter((s) => s.pair === pair && s.side === "ask");
      const bids = slots.filter((s) => s.pair === pair && s.side === "bid");
      // Effective prices in quote units per base unit, compared exactly: the cheapest ask
      // (want / give) is above the dearest bid (give / want).
      for (const ask of asks) {
        for (const bid of bids) expect(ask.wantAmount * bid.wantAmount > bid.giveAmount * ask.giveAmount).toBe(true);
      }
    }
  });

  test("the bridged colours: wStkA and wStkB as recorded, wUSDC recorded or still a loud placeholder", () => {
    const raw = rawBook();
    expect(raw.tokens.wStkA.colour).toBe(RECORDED[0].colour);
    expect(raw.tokens.wStkB.colour).toBe(RECORDED[1].colour);
    for (const symbol of ["wStkA", "wStkB", "wUSDC"]) expect(raw.tokens[symbol].bridge.vault).toBe(VAULT);
    expect(raw.tokens.wUSDC.bridge.erc20).toBe(USDC);
    const file = usableBook();
    checkBridgedColours(file, Object.fromEntries(Object.entries(file.tokens).map(([s, t]) => [s, t.colour!])));
    if (String(raw.tokens.wUSDC.colour).startsWith("PENDING")) {
      expect(() => parseLadderFile(raw)).toThrow(/wUSDC: "colour" is a placeholder/);
    } else {
      expect(raw.tokens.wUSDC.colour).toBe(bridgedColour({ vault: VAULT, erc20: USDC }));
    }
  });

  test("inventory per maker: 1,000 wStk for asks, 2 wUSDC for bids", () => {
    const file = usableBook();
    expect(file.ladders.map((l) => [l.id, l.inventoryTokens, l.giveTokens])).toEqual([
      ["AASK", "1000", "100"],
      ["ABID", "2", "1"],
      ["BASK", "1000", "100"],
      ["BBID", "2", "1"],
    ]);
  });
});

describe("vault colour derivation (AA 00037)", () => {
  test("reproduces every colour AA 00037 recorded on stagenet", () => {
    for (const token of RECORDED) expect(bridgedColour({ vault: VAULT, erc20: token.erc20 })).toBe(token.colour);
    // Case of the ERC20 address does not matter; the vault does.
    expect(bridgedColour({ vault: VAULT, erc20: RECORDED[0].erc20.toLowerCase() })).toBe(RECORDED[0].colour);
    expect(bridgedColour({ vault: "0".repeat(63) + "1", erc20: RECORDED[0].erc20 })).not.toBe(RECORDED[0].colour);
  });

  test("a bridged token whose colour is not the vault's is refused", () => {
    const raw = rawBook();
    raw.tokens.wUSDC.colour = RECORDED[2].colour; // wStkC's colour under USDC's bridge
    const file = parseLadderFile(raw);
    const colours = Object.fromEntries(Object.entries(file.tokens).map(([s, t]) => [s, t.colour!]));
    expect(() => checkBridgedColours(file, colours)).toThrow(/wUSDC: colour .* is not the vault's colour/);
  });
});

describe("book ladder validation", () => {
  const tokens = { S: { decimals: 6 }, U: { decimals: 6 } };
  const ask = { id: "SASK", side: "ask", base: "S", quote: "U", prices: ["0.0104", "0.0108"], giveTokens: "100" };
  const bid = { id: "SBID", side: "bid", base: "S", quote: "U", prices: ["0.0096", "0.0092"], giveTokens: "1" };
  const file = (ladders: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, networkId: "stagenet", mode: "wallet-per-slot", tokens, ladders, ...extra });

  test("a crossing or unordered book, or a mixed grid/book entry, is refused", () => {
    expect(() => parseLadderFile(file([ask, bid]))).not.toThrow();
    expect(() => parseLadderFile(file([ask, { ...bid, prices: ["0.0104", "0.0092"] }]))).toThrow(/crosses/);
    expect(() => parseLadderFile(file([{ ...ask, prices: ["0.0108", "0.0104"] }]))).toThrow(/strictly increasing/);
    expect(() => parseLadderFile(file([{ ...bid, prices: ["0.0092", "0.0096"] }]))).toThrow(/strictly decreasing/);
    expect(() => parseLadderFile(file([{ ...ask, side: "buy" }]))).toThrow(/"side"/);
    expect(() => parseLadderFile(file([{ ...ask, give: "S" }]))).toThrow(/not used by a book ladder/);
    expect(() => parseLadderFile(file([{ ...ask, mid: "0.01" }]))).toThrow(/not used by a book ladder/);
    expect(() => parseLadderFile(file([{ id: "G", give: "S", want: "U", prices: ["1"] }]))).toThrow(/belongs to a book ladder/);
    expect(() => parseLadderFile(file([{ ...ask, prices: ["0"] }]))).toThrow(/positive/);
    expect(() => parseLadderFile(file([{ ...ask, giveTokens: undefined }]))).toThrow(/giveTokens/);
    expect(() => parseLadderFile(file([{ ...ask, quote: "S" }]))).toThrow(/differ/);
    expect(() => parseLadderFile(file([{ ...ask, inventoryTokens: "50" }]))).toThrow(/inventoryTokens/);
  });

  test("wallets: one per level, well formed, never shared by two slots", () => {
    const mapped = parseLadderFile(file([{ ...ask, wallets: ["AB-01", "AB-02"] }, { ...bid, wallets: ["AB-06", "AB-07"] }]));
    expect(buildSlots(mapped).map((s) => [s.id, s.walletId])).toEqual([
      ["SASK-01", "AB-01"],
      ["SASK-02", "AB-02"],
      ["SBID-01", "AB-06"],
      ["SBID-02", "AB-07"],
    ]);
    expect(() => parseLadderFile(file([{ ...ask, wallets: ["AB-01"] }]))).toThrow(/one wallet per level/);
    expect(() => parseLadderFile(file([{ ...ask, wallets: ["AB-01", "ab-2"] }]))).toThrow(/wallet ids/);
    expect(() => parseLadderFile(file([{ ...ask, wallets: ["AB-01", "AB-01"] }]))).toThrow(/used by slots/);
    expect(() => parseLadderFile(file([{ ...ask, wallets: ["AB-01", "AB-02"] }, { ...bid, wallets: ["AB-02", "AB-07"] }]))).toThrow(/AB-02 is used by slots/);
    // A mapped wallet may not be another slot's default wallet either.
    expect(() => parseLadderFile(file([{ ...ask, wallets: ["SBID-01", "AB-02"] }, bid]))).toThrow(/SBID-01 is used by slots/);
  });

  test("colours: a PENDING placeholder fails loudly; a bridge needs an explicit colour", () => {
    const withToken = (token: unknown) => file([ask], { tokens: { ...tokens, U: token } });
    expect(() => parseLadderFile(withToken({ decimals: 6, colour: "PENDING: AA 00037 P7" }))).toThrow(/placeholder/);
    expect(() => parseLadderFile(withToken({ decimals: 6, colour: null, bridge: { vault: VAULT, erc20: USDC } }))).toThrow(/explicit "colour"/);
    expect(() => parseLadderFile(withToken({ decimals: 6, colour: "a".repeat(64), bridge: { vault: VAULT, erc20: "0x12" } }))).toThrow(/bridge.erc20/);
    expect(() => parseLadderFile(withToken({ decimals: 6, colour: "a".repeat(64), bridge: { vault: "xyz", erc20: USDC } }))).toThrow(/bridge.vault/);
  });

  test("mulCeil rounds up, exact values stay exact", () => {
    expect(mulCeil(1_000_000n, { num: 10_000n, den: 92n })).toBe(108_695_653n);
    expect(mulCeil(100_000_000n, { num: 104n, den: 10_000n })).toBe(1_040_000n);
    expect(mulCeil(0n, { num: 1n, den: 3n })).toBe(0n);
  });
});

describe("backward compatibility: the 00053 ladder files", () => {
  const GRID = [80_000_000n, 84_444_444n, 88_888_889n, 93_333_333n, 97_777_778n, 102_222_222n, 106_666_667n, 111_111_111n, 115_555_556n, 120_000_000n];
  const PRICES = ["0.800", "0.844", "0.889", "0.933", "0.978", "1.022", "1.067", "1.111", "1.156", "1.200"];
  const read = (path: string) => buildSlots(parseLadderFile(JSON.parse(readFileSync(path, "utf8"))));

  test("stagenet.json: the same 20 slots, prices and amounts; wallet = slot id; no side", () => {
    const slots = read("ladders/stagenet.json");
    expect(slots.map((s) => [s.id, s.priceText, s.giveSymbol, s.wantSymbol, s.giveAmount, s.wantAmount, s.walletId, s.side])).toEqual([
      ...GRID.map((want, i) => [`AB-${String(i + 1).padStart(2, "0")}`, PRICES[i], "stkA", "stkB", 100_000_000n, want, `AB-${String(i + 1).padStart(2, "0")}`, undefined]),
      ...GRID.map((want, i) => [`BC-${String(i + 1).padStart(2, "0")}`, PRICES[i], "stkB", "stkC", 100_000_000n, want, `BC-${String(i + 1).padStart(2, "0")}`, undefined]),
    ]);
  });

  test("stagenet.stage1.json and stagenet.test.json are unchanged too", () => {
    expect(read("ladders/stagenet.stage1.json").map((s) => [s.id, s.priceText, s.wantAmount, s.walletId])).toEqual([
      ["AB-01", "0.800", 80_000_000n, "AB-01"],
      ["AB-02", "0.844", 84_444_444n, "AB-02"],
      ["BC-01", "0.800", 80_000_000n, "BC-01"],
    ]);
    expect(read("ladders/stagenet.test.json").map((s) => [s.id, s.priceText, s.wantAmount])).toEqual([
      ["AB-01", "0.800", 80_000_000n],
      ["AB-02", "1.000", 100_000_000n],
      ["AB-03", "1.200", 120_000_000n],
      ["BC-01", "0.800", 80_000_000n],
      ["BC-02", "1.000", 100_000_000n],
      ["BC-03", "1.200", 120_000_000n],
    ]);
  });
});

describe("the book view (/status and offers:verify)", () => {
  const record = (slot: string, side: "ask" | "bid", price: string, state: SlotRecord["state"], give: bigint, want: bigint) =>
    ({ slot, side, pair: "wStkA/wUSDC", price, state, giveAmount: give.toString(), wantAmount: want.toString() }) as const;

  test("best bid, best ask and depth come from slots that hold an offer", () => {
    const [book] = bookSummary(
      [
        record("AASK-01", "ask", "0.0104", "consumed", 100_000_000n, 1_040_000n), // being re-offered: not outstanding
        record("AASK-02", "ask", "0.0108", "stored", 100_000_000n, 1_080_000n),
        record("AASK-03", "ask", "0.0112", "live", 100_000_000n, 1_120_000n),
        record("ABID-01", "bid", "0.0096", "stored", 1_000_000n, 104_166_667n),
        record("ABID-02", "bid", "0.0092", "depleted", 1_000_000n, 108_695_653n),
        { slot: "AB-01", price: "0.800", state: "stored", giveAmount: "1", wantAmount: "1" } as never, // grid slot: ignored
      ],
      { wStkA: 6, wUSDC: 6 },
    );
    expect(book).toEqual({
      pair: "wStkA/wUSDC",
      bestBid: "0.0096",
      bestAsk: "0.0108",
      crossed: false,
      asks: { levels: 3, offers: 2, best: "0.0108", base: "200000000", quote: "2200000", baseTokens: "200", quoteTokens: "2.2" },
      bids: { levels: 2, offers: 1, best: "0.0096", base: "104166667", quote: "1000000", baseTokens: "104.166667", quoteTokens: "1" },
    });
  });

  test("a crossed book is flagged; a pair with no offers has no best prices", () => {
    const [crossed] = bookSummary([record("X-01", "ask", "0.0100", "stored", 1n, 1n), record("Y-01", "bid", "0.0100", "stored", 1n, 1n)]);
    expect(crossed!.crossed).toBe(true);
    const [empty] = bookSummary([record("X-01", "ask", "0.0104", "depleted", 1n, 1n)]);
    expect(empty).toMatchObject({ bestAsk: null, bestBid: null, crossed: false, asks: { offers: 0, base: "0" } });
  });

  test("formatUnits", () => {
    expect(formatUnits(1_040_000n, 6)).toBe("1.04");
    expect(formatUnits(100_000_000n, 6)).toBe("100");
    expect(formatUnits(0n, 6)).toBe("0");
  });
});

describe("switch-over guard (fresh journal per ladder file)", () => {
  test("outstanding offers of slots the ladder file does not have refuse the start; ended ones do not", async () => {
    const { orphanClaims } = await import("../src/service.ts");
    const journal = (states: [string, SlotRecord["state"]][]) => ({ slots: () => states.map(([slot, state]) => ({ slot, state }) as SlotRecord) });
    const book = [{ slot: "AASK-01" }, { slot: "ABID-01" }];
    // The 00053 journal still holds 20 stored AB/BC offers: starting the book on it is refused.
    expect(orphanClaims(journal([["AB-01", "stored"], ["BC-10", "live"], ["AASK-01", "stored"]]), book)).toEqual(["AB-01", "BC-10"]);
    expect(orphanClaims(journal([["AB-01", "depleted"], ["AB-02", "consumed"], ["AB-03", "halted"]]), book)).toEqual(["AB-03"]);
    expect(orphanClaims(journal([["AASK-01", "stored"], ["ABID-01", "idle"]]), book)).toEqual([]);
  });
});
