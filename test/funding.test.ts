// 00057 FR-003: `makers:fund` — the funding plan from the book, batching per colour, the
// dry run, pending-before-submit records, idempotency, crash recovery and fail-closed records.
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import { bridgedColour } from "../src/bridge.ts";
import {
  batchesOf,
  type FunderOps,
  FundingError,
  type FundingPorts,
  type FundingTarget,
  fundingKey,
  fundMakers,
  loadFundingRecords,
  planFunding,
  serializeFundingRecords,
  type TransferOutput,
  type TransferRecord,
} from "../src/funding.ts";
import { buildSlots, parseLadderFile } from "../src/ladder.ts";
import type { IndexedTx } from "../src/tx-lookup.ts";
import { hex64 } from "./helpers.ts";

/** The committed book, its wUSDC colour derived in memory while the file holds the placeholder. */
const book = () => {
  const raw = JSON.parse(readFileSync("ladders/stagenet.usdc.json", "utf8"));
  if (String(raw.tokens.wUSDC.colour).startsWith("PENDING")) raw.tokens.wUSDC.colour = bridgedColour(raw.tokens.wUSDC.bridge);
  return parseLadderFile(raw);
};

const bookSlots = () => {
  const file = book();
  return buildSlots(file).map((s) => ({ slot: s.id, ladder: s.ladder, walletId: s.walletId, giveColour: file.tokens[s.giveSymbol]!.colour! }));
};

const addressOf = (walletId: string): string => `mn_shield-addr_test1${walletId.toLowerCase()}`;

describe("the funding plan (the book file)", () => {
  test("20 makers: 1,000 wStk to each ask maker, 2 wUSDC to each bid maker", () => {
    const file = book();
    const targets = planFunding(bookSlots(), file, addressOf);
    expect(targets).toHaveLength(20);
    expect(targets.map((t) => [t.slot, t.walletId, t.symbol, t.amount])).toEqual([
      ...[1, 2, 3, 4, 5].map((n) => [`AASK-0${n}`, `AB-0${n}`, "wStkA", 1_000_000_000n]),
      ...[6, 7, 8, 9, 10].map((n) => [`ABID-0${n - 5}`, `AB-${String(n).padStart(2, "0")}`, "wUSDC", 2_000_000n]),
      ...[1, 2, 3, 4, 5].map((n) => [`BASK-0${n}`, `BC-0${n}`, "wStkB", 1_000_000_000n]),
      ...[6, 7, 8, 9, 10].map((n) => [`BBID-0${n - 5}`, `BC-${String(n).padStart(2, "0")}`, "wUSDC", 2_000_000n]),
    ]);
    const totals: Record<string, bigint> = {};
    for (const t of targets) totals[t.symbol] = (totals[t.symbol] ?? 0n) + t.amount;
    // Spec: 5,000 wStkA, 5,000 wStkB and 20 wUSDC to the makers.
    expect(totals).toEqual({ wStkA: 5_000_000_000n, wUSDC: 20_000_000n, wStkB: 5_000_000_000n });
    expect(targets.every((t) => t.shieldedAddress === addressOf(t.walletId))).toBe(true);
  });

  test("a maker without a public address stops the plan; ladders without inventoryTokens are skipped", () => {
    expect(() => planFunding(bookSlots(), book(), (w) => (w === "BC-07" ? undefined : addressOf(w)))).toThrow(/wallet BC-07/);
    const grid = parseLadderFile(JSON.parse(readFileSync("ladders/stagenet.json", "utf8")));
    const gridSlots = buildSlots(grid).map((s) => ({ slot: s.id, ladder: s.ladder, walletId: s.walletId, giveColour: hex64(s.giveSymbol) }));
    expect(planFunding(gridSlots, grid, addressOf)).toEqual([]);
  });

  test("batches: per colour, in order of first appearance, at most N outputs each", () => {
    const targets = planFunding(bookSlots(), book(), addressOf);
    const batches = batchesOf(targets, 5);
    expect(batches.map((b) => [b[0]!.symbol, b.length])).toEqual([
      ["wStkA", 5],
      ["wUSDC", 5],
      ["wUSDC", 5],
      ["wStkB", 5],
    ]);
    expect(batches.every((b) => new Set(b.map((t) => t.colour)).size === 1)).toBe(true);
    expect(batchesOf(targets, 20).map((b) => b.length)).toEqual([5, 10, 5]);
    expect(() => batchesOf(targets, 0)).toThrow(FundingError);
  });
});

// ---------------------------------------------------------------------------
// The loop, with a fake funder and a fake indexer
// ---------------------------------------------------------------------------

const A = hex64("wStkA");
const U = hex64("wUSDC");

const target = (walletId: string, colour: string, amount: bigint): FundingTarget => ({
  slot: `S-${walletId}`,
  walletId,
  symbol: colour === A ? "wStkA" : "wUSDC",
  colour,
  amount,
  shieldedAddress: addressOf(walletId),
});

const TARGETS = [target("AB-01", A, 1_000n), target("AB-02", A, 1_000n), target("AB-06", U, 2n), target("AB-07", U, 2n), target("AB-08", U, 2n)];

class FakeFunder implements FunderOps {
  opened = true;
  held: Record<string, bigint>;
  dust = 1_000n;
  events: string[] = [];
  submitted: TransferOutput[][] = [];
  failSubmitAt: number | undefined;
  #n = 0;
  constructor(held: Record<string, bigint>) {
    this.held = { ...held };
  }
  async balances() {
    return { shielded: this.held, dust: this.dust };
  }
  async prepare(outputs: readonly TransferOutput[]) {
    const n = ++this.#n;
    const identifier = hex64(`tx-${n}`);
    this.events.push(`prepare:${n}`);
    return {
      identifier,
      submit: async () => {
        this.events.push(`submit:${n}`);
        if (this.failSubmitAt === n) throw new Error("node unreachable");
        this.submitted.push([...outputs]);
        for (const o of outputs) this.held[o.colour] = (this.held[o.colour] ?? 0n) - o.amount;
        return { txHash: hex64(`hash-${n}`), blockHeight: 100 + n };
      },
      release: async () => {
        this.events.push(`release:${n}`);
      },
    };
  }
  async settle() {
    this.events.push("settle");
  }
  async close() {
    this.opened = false;
    this.events.push("close");
  }
}

const harness = (options: { held?: Record<string, bigint>; indexer?: Record<string, IndexedTx>; records?: Record<string, TransferRecord> } = {}) => {
  const funder = new FakeFunder(options.held ?? { [A]: 10_000n, [U]: 50n });
  const records: Record<string, TransferRecord> = { ...(options.records ?? {}) };
  const writes: { key: string; status: string; batch: string }[] = [];
  let opens = 0;
  const lookups: string[] = [];
  const ports: FundingPorts = {
    lookup: async (id) => {
      lookups.push(id);
      return options.indexer?.[id];
    },
    openFunder: async () => {
      opens += 1;
      return funder;
    },
  };
  const run = (extra: { dryRun?: boolean; batchSize?: number; targets?: FundingTarget[]; makerBalance?: FundingPorts["makerBalance"] } = {}) =>
    fundMakers(extra.targets ?? TARGETS, { ...ports, makerBalance: extra.makerBalance }, {
      batchSize: extra.batchSize ?? 2,
      dryRun: extra.dryRun ?? false,
      records,
      onRecord: (key, record) => {
        // Every write must reach "disk" before the next step: the fake keeps an ordered log.
        funder.events.push(`record:${record.status}:${record.walletId}`);
        writes.push({ key, status: record.status, batch: record.batch });
        records[key] = record;
      },
      now: () => new Date("2026-09-27T15:00:00Z"),
    });
  return { funder, records, writes, lookups, ports, run, opens: () => opens };
};

describe("fundMakers", () => {
  test("dry run: plans and batches, opens no wallet, writes nothing", async () => {
    const h = harness();
    const report = await h.run({ dryRun: true });
    expect(h.opens()).toBe(0);
    expect(h.writes).toEqual([]);
    expect(report.results.map((r) => r.action)).toEqual(Array(5).fill("send"));
    expect(report.totals).toEqual({ wStkA: "2000", wUSDC: "6" });
    expect(report.batches).toBe(3); // A: 2; U: 2 + 1
  });

  test("run: pending is recorded BEFORE each submit, sent after; change settles between batches", async () => {
    const h = harness();
    const report = await h.run();
    expect(report.results.map((r) => [r.walletId, r.action, r.batch])).toEqual([
      ["AB-01", "sent", "1/3"],
      ["AB-02", "sent", "1/3"],
      ["AB-06", "sent", "2/3"],
      ["AB-07", "sent", "2/3"],
      ["AB-08", "sent", "3/3"],
    ]);
    expect(h.funder.events).toEqual([
      "prepare:1", "record:pending:AB-01", "record:pending:AB-02", "submit:1", "record:sent:AB-01", "record:sent:AB-02", "settle",
      "prepare:2", "record:pending:AB-06", "record:pending:AB-07", "submit:2", "record:sent:AB-06", "record:sent:AB-07", "settle",
      "prepare:3", "record:pending:AB-08", "submit:3", "record:sent:AB-08",
      "close",
    ]);
    expect(h.funder.submitted.map((batch) => batch.map((o) => [o.shieldedAddress, o.amount]))).toEqual([
      [[addressOf("AB-01"), 1_000n], [addressOf("AB-02"), 1_000n]],
      [[addressOf("AB-06"), 2n], [addressOf("AB-07"), 2n]],
      [[addressOf("AB-08"), 2n]],
    ]);
    expect(h.records[fundingKey(TARGETS[0]!)]).toMatchObject({ status: "sent", txId: hex64("tx-1"), txHash: hex64("hash-1"), blockHeight: 101, batch: "1/3" });
    expect(report.funderBefore).toEqual({ shielded: { [A]: "10000", [U]: "50" }, dust: "1000" });
    expect(h.funder.held).toEqual({ [A]: 8_000n, [U]: 44n });
  });

  test("a second run moves nothing and opens no wallet", async () => {
    const h = harness();
    await h.run();
    const opens = h.opens();
    const again = await h.run();
    expect(h.opens()).toBe(opens);
    expect(again.results.map((r) => r.action)).toEqual(Array(5).fill("skip-already-sent"));
    expect(again.batches).toBe(0);
  });

  test("a failed submit stops the run: its pending records stay, later batches are not sent", async () => {
    const h = harness();
    h.funder.failSubmitAt = 2;
    const report = await h.run();
    expect(report.results.map((r) => r.action)).toEqual(["sent", "sent", "error", "error", "not-sent"]);
    expect(h.records[fundingKey(TARGETS[2]!)]).toMatchObject({ status: "pending", txId: hex64("tx-2") });
    expect(h.records[fundingKey(TARGETS[4]!)]).toBeUndefined();
    expect(h.funder.events.at(-1)).toBe("close");
  });

  test("re-run after a crash: a pending transfer the indexer confirms becomes sent, one it does not know is never re-sent", async () => {
    const pending = (walletId: string, colour: string, n: number): TransferRecord => ({
      status: "pending", walletId, slot: `S-${walletId}`, symbol: "wUSDC", colour, amount: "2", txId: hex64(`old-${n}`), batch: "2/3", at: "2026-09-27T14:00:00Z",
    });
    const records = {
      [`AB-06/${U}`]: pending("AB-06", U, 1),
      [`AB-07/${U}`]: pending("AB-07", U, 2),
    };
    const indexer = { [hex64("old-1")]: { hash: hex64("h-old-1"), blockHeight: 90, status: "SUCCESS", identifiers: [hex64("old-1")] } };
    const h = harness({ records, indexer });
    const report = await h.run();
    const byWallet = Object.fromEntries(report.results.map((r) => [r.walletId, r]));
    expect(byWallet["AB-06"]).toMatchObject({ action: "skip-already-sent", txHash: hex64("h-old-1"), blockHeight: 90 });
    expect(h.records[`AB-06/${U}`]).toMatchObject({ status: "sent", reconciled: true, txHash: hex64("h-old-1") });
    expect(byWallet["AB-07"]).toMatchObject({ action: "skip-pending-unresolved", detail: "not indexed" });
    expect(h.records[`AB-07/${U}`]!.status).toBe("pending");
    // Only the makers that were never paid are sent now.
    expect(h.funder.submitted.flat().map((o) => o.shieldedAddress)).toEqual([addressOf("AB-01"), addressOf("AB-02"), addressOf("AB-08")]);
  });

  test("a short funding wallet (or no DUST) is refused before anything is sent", async () => {
    const h = harness({ held: { [A]: 10_000n, [U]: 5n } });
    await expect(h.run()).rejects.toThrow(/holds 5 .* needs 6; nothing was sent/);
    expect(h.funder.submitted).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.funder.opened).toBe(false);
    const dry = harness();
    dry.funder.dust = 0n;
    await expect(dry.run()).rejects.toThrow(/no DUST/);
  });

  test("--check-balances: a maker already holding its inventory is skipped", async () => {
    const h = harness();
    const report = await h.run({ makerBalance: async (walletId, colour) => (walletId === "AB-02" && colour === A ? 1_000n : 0n) });
    expect(report.results.map((r) => [r.walletId, r.action])).toEqual([
      ["AB-01", "sent"],
      ["AB-02", "skip-already-holds"],
      ["AB-06", "sent"],
      ["AB-07", "sent"],
      ["AB-08", "sent"],
    ]);
  });
});

describe("maker-funding.json", () => {
  const record: TransferRecord = {
    status: "sent", walletId: "AB-01", slot: "AASK-01", symbol: "wStkA", colour: A, amount: "1000000000", txId: hex64("t"), batch: "1/4", at: "2026-09-27T15:00:00Z", txHash: hex64("h"), blockHeight: 1,
  };

  test("round trip; a missing file is an empty history", () => {
    const text = serializeFundingRecords({ [`AB-01/${A}`]: record }, "stagenet");
    expect(loadFundingRecords(JSON.parse(text), true, "stagenet")).toEqual({ [`AB-01/${A}`]: record });
    expect(loadFundingRecords(undefined, false, "stagenet")).toEqual({});
  });

  test("a present but malformed or foreign document is refused, never treated as empty", () => {
    const doc = (transfers: unknown, extra: Record<string, unknown> = {}) => ({ version: 1, networkId: "stagenet", transfers, ...extra });
    expect(() => loadFundingRecords(null, true, "stagenet")).toThrow(FundingError);
    expect(() => loadFundingRecords(doc({}, { version: 2 }), true, "stagenet")).toThrow(/version/);
    expect(() => loadFundingRecords(doc({}), true, "undeployed")).toThrow(/is for stagenet/);
    expect(() => loadFundingRecords(doc({ [`AB-01/${A}`]: { ...record, status: "maybe" } }), true, "stagenet")).toThrow(/malformed/);
    expect(() => loadFundingRecords(doc({ [`AB-02/${A}`]: record }), true, "stagenet")).toThrow(/malformed/);
    expect(() => loadFundingRecords(doc({ [`AB-01/${A}`]: { ...record, txId: "zz" } }), true, "stagenet")).toThrow(/malformed/);
  });
});
