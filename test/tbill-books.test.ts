// 00058: T-bill books — TB13W / TB26W / TB52W sold for wUSDC at the owner's FIXED prices,
// 10 tokens per offer, one single-level ask ladder (and one maker wallet) per offer. Checks
// the exact raw amounts, asks only, the bridged colours, that the 20 existing book slots are
// unchanged (so the live journal accepts the new file), the T-bill-first order, the funding
// plan, the /status book view of an ask-only pair, and the public makers file's join.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPublicMakers } from "../src/addresses.ts";
import { bookSummary } from "../src/book.ts";
import { bridgedColour } from "../src/bridge.ts";
import { planFunding } from "../src/funding.ts";
import { openJournal } from "../src/journal.ts";
import { buildSlots, readLadderFile } from "../src/ladder.ts";
import { loadServiceConfig, orphanClaims } from "../src/service.ts";
import { startStatusServer } from "../src/status.ts";
import { withinLevel } from "../src/verify.ts";
import { generateMakers } from "../src/wallets.ts";

const BOOKS = "ladders/stagenet.books.json";
const USDC_BOOK = "ladders/stagenet.usdc.json";
const VAULT = "7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637";
const WUSDC = "e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d";

/** Spec FR-001 and AA 00045's records (passport PR #4 @ 6c7505a). */
const TBILLS = [
  {
    symbol: "TB13W",
    ladder: "T13",
    price: "0.9899",
    want: 9_899_000n,
    colour: "b3d96e9933fb4548ce8a17a63f4c92bb3894b3571873c3edcc8a08aa7ce2512b",
    erc20: "0x5cF366decA552c30eBB2504d0b9Ee104A99f1c72",
  },
  {
    symbol: "TB26W",
    ladder: "T26",
    price: "0.9905",
    want: 9_905_000n,
    colour: "7b044b55c0493a67eeb16f25d3757eea07f9abaf55e374739953afd449bc3b62",
    erc20: "0x26dB7221903e62310409e454442adBb46E0B6E33",
  },
  {
    symbol: "TB52W",
    ladder: "T52",
    price: "0.9806",
    want: 9_806_000n,
    colour: "8f4798a5ee48747f37562da76ed8711ad4b4ea1ad7ac16d80eb74b92792b9ec2",
    erc20: "0x02A0D1BaF66351715A84aC4763b82f1155BdD5b0",
  },
] as const;
const TBILL_SLOTS = TBILLS.flatMap((t) => ["A", "B", "C"].map((x) => `${t.ladder}${x}-01`));

describe("the T-bill ladders (spec FR-001/002/004)", () => {
  test("9 single-level asks: 10 tokens for exactly 10 × price wUSDC, one maker wallet each", () => {
    const file = readLadderFile(BOOKS);
    const slots = buildSlots(file);
    expect(slots).toHaveLength(29);
    for (const t of TBILLS) {
      const mine = slots.filter((s) => s.giveSymbol === t.symbol);
      expect(mine.map((s) => s.id)).toEqual(["A", "B", "C"].map((x) => `${t.ladder}${x}-01`));
      expect(mine.map((s) => s.walletId)).toEqual([1, 2, 3].map((n) => `${t.ladder}-0${n}`));
      for (const slot of mine) {
        expect(slot).toMatchObject({ side: "ask", pair: `${t.symbol}/wUSDC`, wantSymbol: "wUSDC", priceText: t.price, level: 0 });
        expect(slot.giveAmount).toBe(10_000_000n);
        expect(slot.wantAmount).toBe(t.want);
        // The fixed price exactly: 10 × price, no rounding at all (FR-001)…
        expect(slot.wantAmount * 10n ** 6n).toBe(slot.giveAmount * BigInt(t.price.replace(".", "")) * 100n);
        // …and at the level, with one base unit less below it.
        expect(withinLevel("ask", slot.priceText, slot.giveAmount, slot.wantAmount, { base: 6, quote: 6 })).toBe(true);
        expect(withinLevel("ask", slot.priceText, slot.giveAmount, slot.wantAmount - 1n, { base: 6, quote: 6 })).toBe(false);
      }
      const ladders = file.ladders.filter((l) => l.give === t.symbol);
      expect(ladders.map((l) => [l.id, l.levels, l.giveTokens, l.inventoryTokens, l.book?.prices])).toEqual(
        ["A", "B", "C"].map((x) => [`${t.ladder}${x}`, 1, "10", "100", [t.price]]),
      );
    }
  });

  test("the T-bill colours are the vault's (AA 00045), and the config loads with the bridge check", () => {
    const raw = JSON.parse(readFileSync(BOOKS, "utf8")) as { tokens: Record<string, { decimals: number; colour: string; bridge: { vault: string; erc20: string } }> };
    for (const t of TBILLS) {
      expect(raw.tokens[t.symbol]).toEqual({ decimals: 6, colour: t.colour, bridge: { vault: VAULT, erc20: t.erc20 } });
      expect(bridgedColour({ vault: VAULT, erc20: t.erc20 })).toBe(t.colour);
    }
    const config = loadServiceConfig({ ladderFile: BOOKS }); // runs checkBridgedColours
    expect(config.mode).toBe("wallet-per-slot");
    for (const t of TBILLS) expect(config.colours[t.symbol]).toBe(t.colour);
    expect(config.colours["wUSDC"]).toBe(WUSDC);
    // The existing three tokens are copied verbatim from the 00057 book.
    const usdc = JSON.parse(readFileSync(USDC_BOOK, "utf8")) as { tokens: Record<string, unknown> };
    for (const symbol of ["wStkA", "wStkB", "wUSDC"]) expect(raw.tokens[symbol]).toEqual(usdc.tokens[symbol] as never);
  });

  test("asks only: no T-bill bid, and no book crosses", () => {
    const slots = buildSlots(readLadderFile(BOOKS));
    expect(slots.filter((s) => s.pair?.startsWith("TB") && s.side !== "ask")).toEqual([]);
    const books = bookSummary(
      slots.map((s) => ({ side: s.side, pair: s.pair, price: s.priceText, state: "live" as const, giveAmount: s.giveAmount.toString(), wantAmount: s.wantAmount.toString() })),
      { TB13W: 6, TB26W: 6, TB52W: 6, wStkA: 6, wStkB: 6, wUSDC: 6 },
    );
    expect(books.map((b) => [b.pair, b.bestBid, b.bestAsk, b.crossed, b.asks.offers, b.bids.offers])).toEqual([
      ["TB13W/wUSDC", null, "0.9899", false, 3, 0],
      ["TB26W/wUSDC", null, "0.9905", false, 3, 0],
      ["TB52W/wUSDC", null, "0.9806", false, 3, 0],
      ["wStkA/wUSDC", "0.0096", "0.0104", false, 5, 5],
      ["wStkB/wUSDC", "0.0096", "0.0104", false, 5, 5],
    ]);
  });
});

describe("the switch keeps the 20 existing slots (spec FR-005, FR-009)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "o58-tbill-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("stagenet.usdc.json is unchanged (the running book)", () => {
    const sha = createHash("sha256").update(readFileSync(USDC_BOOK)).digest("hex");
    expect(sha).toBe("6e0a62c8e6e3bbdead281993a1b8a07fd93400da6bbed4b6ffb5b1dc707d7252"); // main @ 669ded0
  });

  test("the 20 book slots are identical to stagenet.usdc.json's, and the T-bill slots come first", () => {
    const before = loadServiceConfig({ ladderFile: USDC_BOOK }).slots;
    const after = loadServiceConfig({ ladderFile: BOOKS }).slots;
    expect(before).toHaveLength(20);
    expect(after).toHaveLength(29);
    // Tick order = config order: the 9 T-bill slots first (FR-009), then the 20 unchanged.
    expect(after.slice(0, 9).map((s) => s.slot)).toEqual(TBILL_SLOTS);
    expect(after.slice(9)).toEqual([...before]);
  });

  test("the live journal accepts the new file: old slots keep their state, new slots start idle", () => {
    const before = loadServiceConfig({ ladderFile: USDC_BOOK }).slots;
    const after = loadServiceConfig({ ladderFile: BOOKS }).slots;
    const journal = openJournal({ file: join(dir, "ladder.books.journal.json"), networkId: "stagenet", mode: "wallet-per-slot" });
    for (const slot of before) journal.ensureSlot(slot);
    // Two of the old slots hold an offer, as on the live service.
    for (const [index, slot] of [before[0]!, before[5]!].entries()) {
      journal.beginOffer(slot.slot, {
        offerId: `${index}`.repeat(64),
        blobSha256: "b".repeat(64),
        delivery: "outbox",
        coinNonce: `${index + 2}`.repeat(64),
        coinNullifier: `${index + 4}`.repeat(64),
        coinValue: slot.giveAmount,
        giveAmount: slot.giveAmount,
        wantAmount: slot.wantAmount,
        ttlSec: 3600,
        builtAt: "2026-09-27T20:57:31.000Z",
        expiresAt: "2026-09-27T21:57:31.000Z",
      });
    }
    const states = new Map(journal.slots().map((r) => [r.slot, r.state]));
    for (const slot of after) expect(() => journal.ensureSlot(slot)).not.toThrow(); // SLOT_MISMATCH would throw
    expect(orphanClaims(journal, after)).toEqual([]);
    for (const [slot, state] of states) expect(journal.get(slot)!.state).toBe(state);
    for (const slot of TBILL_SLOTS) expect(journal.get(slot)!.state).toBe("idle");
    expect(journal.get(before[0]!.slot)!.current?.offerId).toBe("0".repeat(64));
  });
});

describe("funding plan and public makers for the T-bill slots", () => {
  test("makers:fund --slots <T-bill slots>: 9 makers × 100 of their T-bill, nothing else", () => {
    const config = loadServiceConfig({ ladderFile: BOOKS });
    const chosen = config.slots.filter((s) => TBILL_SLOTS.includes(s.slot));
    const targets = planFunding(chosen, config.ladders, (walletId) => `shielded:${walletId}`);
    expect(targets.map((t) => [t.slot, t.walletId, t.symbol, t.amount, t.shieldedAddress])).toEqual(
      TBILLS.flatMap((t) =>
        ["A", "B", "C"].map((x, i) => [`${t.ladder}${x}-01`, `${t.ladder}-0${i + 1}`, t.symbol, 100_000_000n, `shielded:${t.ladder}-0${i + 1}`]),
      ),
    );
    for (const t of targets) expect(t.colour).toBe(TBILLS.find((b) => b.symbol === t.symbol)!.colour);
  });

  test("the public makers file joins each maker to the slot that uses it (questions-file Q4)", () => {
    const makers = generateMakers("stagenet", [
      { slot: "AB-01", ladder: "AB", level: 0 },
      { slot: "AB-06", ladder: "AB", level: 5 },
      { slot: "T13-01", ladder: "T13", level: 0 },
      { slot: "T52-03", ladder: "T52", level: 2 },
      { slot: "ZZ-01", ladder: "ZZ", level: 0 },
    ]);
    const published = buildPublicMakers(makers, readLadderFile(BOOKS));
    expect(published.makers.map((m) => [m.slot, m.price, m.gives, m.wants, m.giveTokensPerOffer])).toEqual([
      ["AB-01", "0.0104", "wStkA", "wUSDC", "100"],
      ["AB-06", "0.0096", "wUSDC", "wStkA", "1"],
      ["T13-01", "0.9899", "TB13W", "wUSDC", "10"],
      ["T52-03", "0.9806", "TB52W", "wUSDC", "10"],
      ["ZZ-01", null, null, null, null],
    ]);
    const text = JSON.stringify(published);
    for (const maker of makers.makers) expect(text).not.toContain(maker.mnemonic.split(" ").slice(0, 3).join(" "));
  });
});

describe("/status books: an ask-only pair", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "o58-status-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("shows the best ask and no bid, not crossed; a pair with no offer yet has no best price", async () => {
    const config = loadServiceConfig({ ladderFile: BOOKS });
    const journal = openJournal({ file: join(dir, "j.json"), networkId: "stagenet", mode: "wallet-per-slot" });
    for (const slot of config.slots) journal.ensureSlot(slot);
    for (const [i, id] of ["T13A-01", "T13B-01", "T13C-01"].entries()) {
      const slot = config.slots.find((s) => s.slot === id)!;
      journal.beginOffer(id, {
        offerId: createHash("sha256").update(`offer${i}`).digest("hex"),
        blobSha256: "b".repeat(64),
        delivery: "outbox",
        coinNonce: createHash("sha256").update(`coin${i}`).digest("hex"),
        coinNullifier: createHash("sha256").update(`null${i}`).digest("hex"),
        coinValue: "100000000",
        giveAmount: slot.giveAmount,
        wantAmount: slot.wantAmount,
        ttlSec: 3600,
        builtAt: "2026-09-29T19:00:00.000Z",
        expiresAt: "2026-09-29T20:00:00.000Z",
      });
    }
    const now = Date.now();
    const tokenDecimals = Object.fromEntries(Object.entries(config.ladders.tokens).map(([symbol, token]) => [symbol, token.decimals]));
    const server = startStatusServer(
      { journal, startedAt: now, delivery: "kernel", mode: "wallet-per-slot", lastTickEndedAt: () => now, inventory: () => undefined, now: () => now, tokenDecimals },
      { port: 0, hostname: "127.0.0.1", staleAfterMs: 600_000 },
    );
    try {
      const status = (await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as { books: ({ pair: string } & Record<string, unknown>)[] };
      const byPair = new Map(status.books.map((b) => [b.pair, b]));
      expect(byPair.get("TB13W/wUSDC")).toEqual({
        pair: "TB13W/wUSDC",
        bestBid: null,
        bestAsk: "0.9899",
        crossed: false,
        asks: { levels: 3, offers: 3, best: "0.9899", base: "30000000", quote: "29697000", baseTokens: "30", quoteTokens: "29.697" },
        bids: { levels: 0, offers: 0, best: null, base: "0", quote: "0", baseTokens: "0", quoteTokens: "0" },
      });
      expect(byPair.get("TB26W/wUSDC")).toMatchObject({ bestBid: null, bestAsk: null, crossed: false, asks: { levels: 3, offers: 0 } });
      expect(byPair.get("wStkA/wUSDC")).toMatchObject({ bestBid: null, bestAsk: null, crossed: false, asks: { levels: 5 }, bids: { levels: 5 } });
    } finally {
      await server.stop();
    }
  });
});
