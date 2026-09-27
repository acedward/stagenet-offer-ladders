// P12 tooling fixes (fakes only, no network): the indexer fallback for a missed Finalized
// notice, per-UTxO DUST-registration detail in makers:status, and the ledger-9 root-window
// default.
import { afterEach, describe, expect, test } from "bun:test";

import { MISSED_FINALIZED_NOTE } from "../src/maker-ops.ts";
import {
  balanceRow,
  type MakerOps,
  type MakerStatus,
  type MintRecord,
  mintAll,
  registerDustAll,
} from "../src/makers.ts";
import { DEFAULT_ROOT_WINDOW_MINUTES, loadServiceConfig } from "../src/service.ts";
import { type IndexedTx, lookupTransaction, submitWithIndexerFallback } from "../src/tx-lookup.ts";

const ID = `00${"ab".repeat(32)}`;
const HASH = "cd".repeat(32);
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const noSleep = async () => undefined;

describe("lookupTransaction (indexer, fake fetch)", () => {
  const reply = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  test("found with SUCCESS: hash, block, status, identifiers; the query carries the identifier", async () => {
    let sent: { query: string; variables: unknown } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ data: { transactions: [{ hash: HASH, block: { height: 637837 }, identifiers: [ID], transactionResult: { status: "SUCCESS" } }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const tx = await lookupTransaction("http://indexer/graphql", { identifier: ID }, fetchImpl);
    expect(tx).toEqual({ hash: HASH, blockHeight: 637837, status: "SUCCESS", identifiers: [ID] });
    expect(sent?.variables).toEqual({ offset: { identifier: ID } });
    expect(sent?.query).toContain("transactions(offset: $offset)");
  });

  test("by hash; not indexed → undefined", async () => {
    expect(await lookupTransaction("http://i", { hash: HASH }, reply({ data: { transactions: [] } }))).toBeUndefined();
  });

  test("GraphQL errors, HTTP errors, malformed replies and non-hex references throw", async () => {
    await expect(lookupTransaction("http://i", { hash: HASH }, reply({ data: null, errors: [{ message: "bad" }] }))).rejects.toThrow("bad");
    await expect(lookupTransaction("http://i", { hash: HASH }, reply({}, 503))).rejects.toThrow("HTTP 503");
    await expect(lookupTransaction("http://i", { hash: HASH }, reply({ data: {} }))).rejects.toThrow("malformed");
    await expect(lookupTransaction("http://i", { hash: "zz" }, reply({}))).rejects.toThrow("hex");
  });
});

describe("submitWithIndexerFallback", () => {
  const found = (status: string): IndexedTx => ({ hash: HASH, blockHeight: 637837, status, identifiers: [ID] });

  test("a submission that finishes in time returns its own value; the indexer is not asked", async () => {
    let asked = 0;
    const out = await submitWithIndexerFallback(async () => "tx-1", {
      timeoutMs: 1_000, label: "x", identifier: () => ID, lookup: async () => (asked++, found("SUCCESS")),
    });
    expect(out).toEqual({ value: "tx-1" });
    expect(asked).toBe(0);
  });

  test("the BC-09 case: deadline passes after submission, the indexer has it with SUCCESS → indexed", async () => {
    const lines: string[] = [];
    const out = await submitWithIndexerFallback(never, {
      timeoutMs: 20, label: "DUST registration", identifier: () => ID, lookup: async () => found("SUCCESS"), sleep: noSleep, log: (l) => lines.push(l),
    });
    expect(out.indexed?.hash).toBe(HASH);
    expect(out.value).toBeUndefined();
    expect(lines.join("\n")).toContain("SUCCESS");
  });

  test("not indexed after every attempt → the timeout error stands (with the indexer's answer)", async () => {
    let asked = 0;
    const run = submitWithIndexerFallback(never, {
      timeoutMs: 20, label: "inventory mint", identifier: () => ID, lookup: async () => (asked++, undefined), attempts: 3, sleep: noSleep,
    });
    await expect(run).rejects.toThrow(/inventory mint timed out.*indexer: not indexed/u);
    expect(asked).toBe(3);
  });

  test("the indexer reports another status → error, asked once (a final answer)", async () => {
    let asked = 0;
    const run = submitWithIndexerFallback(never, {
      timeoutMs: 20, label: "inventory mint", identifier: () => ID, lookup: async () => (asked++, found("FAILURE")), attempts: 3, sleep: noSleep,
    });
    await expect(run).rejects.toThrow(/status FAILURE/u);
    expect(asked).toBe(1);
  });

  test("the indexer cannot answer → error names the lookup failure; the error stays a TimeoutError", async () => {
    const run = submitWithIndexerFallback(never, {
      timeoutMs: 20, label: "x", identifier: () => ID, lookup: async () => { throw new Error("ECONNRESET"); }, attempts: 2, sleep: noSleep,
    });
    const error = (await run.then(() => new Error("resolved"), (e: unknown) => e)) as Error;
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toContain("indexer lookup failed");
  });

  test("a timeout before anything reached the node (no identifier) → original error, no lookup", async () => {
    let asked = 0;
    const run = submitWithIndexerFallback(never, { timeoutMs: 20, label: "x", identifier: () => undefined, lookup: async () => (asked++, found("SUCCESS")) });
    await expect(run).rejects.toThrow("x timed out after 20 ms");
    expect(asked).toBe(0);
  });

  test("a non-timeout error is rethrown unchanged, without a lookup", async () => {
    let asked = 0;
    const run = submitWithIndexerFallback(async () => { throw new Error("proof server down"); }, {
      timeoutMs: 1_000, label: "x", identifier: () => ID, lookup: async () => (asked++, found("SUCCESS")),
    });
    await expect(run).rejects.toThrow("proof server down");
    expect(asked).toBe(0);
  });
});

describe("maker loops carry the indexer note", () => {
  const status = (extra: Partial<MakerStatus> = {}): MakerStatus => ({ nightUtxos: [], dust: 0n, giveBalance: 0n, ...extra });
  const ops = (over: Partial<MakerOps>, st: MakerStatus): MakerOps => ({
    status: async () => st,
    registerDust: async () => ({ txId: "t" }),
    mintGive: async () => ({ txHash: "h", blockHeight: 1, status: "SucceedEntirely", coinNonce: "n" }),
    holdsCoin: async () => false,
    close: async () => undefined,
    ...over,
  });

  test("register: a registration confirmed only by the indexer is `registered` with its note, hash and block", async () => {
    const maker = ops(
      { registerDust: async () => ({ txId: ID, txHash: HASH, blockHeight: 637837, note: MISSED_FINALIZED_NOTE }) },
      status({ nightUtxos: [{ value: 5_000_000_000n, registered: false }] }),
    );
    const [result] = await registerDustAll([{ slot: "BC-09", ladder: "BC" }], async () => maker);
    expect(result).toEqual({ slot: "BC-09", action: "registered", detail: { txId: ID, txHash: HASH, blockHeight: 637837, note: MISSED_FINALIZED_NOTE, utxos: 1 } });
  });

  test("mint: a mint confirmed only by the indexer is `minted` and its record is written with the note", async () => {
    const records: Record<string, MintRecord> = {};
    const maker = ops(
      { mintGive: async (_a, nonce) => ({ txHash: HASH, blockHeight: 9, status: "SucceedEntirely", coinNonce: nonce, note: MISSED_FINALIZED_NOTE }) },
      status({ dust: 10n ** 16n }),
    );
    const nonce = "ee".repeat(32);
    const [result] = await mintAll([{ slot: "AB-01", ladder: "AB" }], async () => maker, 1_000_000_000n, 10n ** 15n, {
      records,
      onRecord: (slot, record) => void (records[slot] = record),
      newNonce: () => nonce,
    });
    expect(result?.action).toBe("minted");
    expect((result?.detail as { note?: string }).note).toBe(MISSED_FINALIZED_NOTE);
    expect(records["AB-01"]).toMatchObject({ status: "minted", nonce, txHash: HASH, blockHeight: 9, note: MISSED_FINALIZED_NOTE });
  });

  test("mint: a timeout the indexer does not confirm stays an error and keeps the pending record", async () => {
    const records: Record<string, MintRecord> = {};
    const maker = ops(
      { mintGive: async () => { const e = new Error("inventory mint timed out after 900000 ms; indexer: not indexed"); e.name = "TimeoutError"; throw e; } },
      status({ dust: 10n ** 16n }),
    );
    const [result] = await mintAll([{ slot: "AB-01", ladder: "AB" }], async () => maker, 1_000_000_000n, 10n ** 15n, {
      records,
      onRecord: (slot, record) => void (records[slot] = record),
    });
    expect(result?.action).toBe("error");
    expect(records["AB-01"]?.status).toBe("pending");
  });
});

describe("makers:status balance row (Q9)", () => {
  test("per-UTxO value, ctime and registration flag; registered count; DUST; shielded per colour", () => {
    const row = balanceRow({
      night: 5_000_000_000n,
      dust: 130n * 10n ** 15n,
      nightUtxos: [
        { value: 4_000_000_000n, ctime: "2026-09-26T21:03:00.000Z", registeredForDustGeneration: true },
        { value: 1_000_000_000n, ctime: "2026-09-27T00:00:00.000Z", registeredForDustGeneration: false },
      ],
      shielded: { ["aa".repeat(32)]: 1_000_000_000n },
      shieldedCoins: { ["aa".repeat(32)]: 1 },
    });
    expect(row.nightUtxos).toBe(2);
    expect(row.nightRegistered).toBe(1);
    expect(row.nightUtxoDetail).toEqual([
      { value: 4_000_000_000n, ctime: "2026-09-26T21:03:00.000Z", registeredForDustGeneration: true },
      { value: 1_000_000_000n, ctime: "2026-09-27T00:00:00.000Z", registeredForDustGeneration: false },
    ]);
    expect(row.dust).toBe(130n * 10n ** 15n);
    expect(row.shielded).toEqual({ ["aa".repeat(32)]: { value: 1_000_000_000n, coins: 1 } });
  });
});

describe("root window default (ledger 9)", () => {
  const saved = process.env["ROOT_WINDOW_MINUTES"];
  afterEach(() => {
    if (saved === undefined) delete process.env["ROOT_WINDOW_MINUTES"];
    else process.env["ROOT_WINDOW_MINUTES"] = saved;
  });

  test("defaults to 14 days (global_ttl 1,209,600 s); ROOT_WINDOW_MINUTES still overrides it", () => {
    delete process.env["ROOT_WINDOW_MINUTES"];
    expect(DEFAULT_ROOT_WINDOW_MINUTES * 60).toBe(1_209_600);
    expect(loadServiceConfig().scheduler.rootWindowMs).toBe(1_209_600_000);
    process.env["ROOT_WINDOW_MINUTES"] = "60";
    expect(loadServiceConfig().scheduler.rootWindowMs).toBe(3_600_000);
  });
});
