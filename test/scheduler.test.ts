// Scheduler with a fake clock, fake wallets (real builder + pin selector) and, in kernel
// mode, the in-process mock kernel over real HTTP.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal, writeAtomic } from "../src/journal.ts";
import { KernelClient } from "../src/kernel-client.ts";
import { Outbox } from "../src/outbox.ts";
import { chooseCoin, retryDelayMs, Scheduler, type SchedulerConfig, type SlotPlan } from "../src/scheduler.ts";
import { isHealthy, startStatusServer, statusRows } from "../src/status.ts";
import { COLOUR_A, COLOUR_B, COLOUR_C, coin, decodeFakeOffer, FakeClock, FakeWallet, FakeWallets, MockKernel } from "./helpers.ts";

const HOUR = 3_600_000;
const GIVE = 100_000_000n;

let dir: string;
let kernel: MockKernel | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o53-sched-"));
  kernel = undefined;
});
afterEach(async () => {
  await kernel?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const cfg = (extra: Partial<SchedulerConfig> = {}): SchedulerConfig => ({
  networkId: "stagenet",
  mode: "single-wallet-pinned",
  coinPolicy: "exact",
  offerTtlMs: HOUR,
  expiryGraceMs: 5_000,
  retryBaseMs: 60_000,
  retryMaxMs: HOUR,
  excludeNonces: new Set(),
  maxBuildsPerTick: Number.POSITIVE_INFINITY,
  outboxRetentionMs: 7 * 24 * HOUR,
  rootWindowMs: HOUR,
  submitConfirmMs: 5 * 60_000,
  buildTimeoutMs: 60_000,
  versionCheckEveryTicks: 0,
  freshStartAck: true,
  ...extra,
});

const PRICES = [
  ["0.800", 80_000_000n],
  ["1.000", 100_000_000n],
  ["1.200", 120_000_000n],
] as const;

/** 3 AB + 3 BC slots (the P3 test ladder). */
const testSlots = (walletOf: (slot: string) => string): SlotPlan[] =>
  (["AB", "BC"] as const).flatMap((ladder) =>
    PRICES.map(([price, want], level) => {
      const slot = `${ladder}-0${level + 1}`;
      return {
        slot,
        ladder,
        level,
        walletId: walletOf(slot),
        giveColour: ladder === "AB" ? COLOUR_A : COLOUR_B,
        wantColour: ladder === "AB" ? COLOUR_B : COLOUR_C,
        giveAmount: GIVE.toString(),
        wantAmount: want.toString(),
        price,
      };
    }),
  );

/** The funding wallet of the P3 test: stkA 3×100, stkB 3×100 + 1×1000 reserve, stkC 1×1000 reserve. */
const fundingWallet = (): FakeWallet =>
  new FakeWallet("funding", [
    coin(COLOUR_A, "A1", GIVE),
    coin(COLOUR_A, "A2", GIVE),
    coin(COLOUR_A, "A3", GIVE),
    coin(COLOUR_B, "B1", GIVE),
    coin(COLOUR_B, "B2", GIVE),
    coin(COLOUR_B, "B3", GIVE),
    coin(COLOUR_B, "Breserve", 10n * GIVE),
    coin(COLOUR_C, "Creserve", 10n * GIVE),
  ]);

interface Rig {
  scheduler: Scheduler;
  clock: FakeClock;
  outbox: Outbox;
  journalFile: string;
  logs: Record<string, unknown>[];
}

const rig = (options: {
  wallets: FakeWallet[];
  slots: SlotPlan[];
  config?: Partial<SchedulerConfig>;
  kernelClient?: KernelClient;
  clock?: FakeClock;
  journalFile?: string;
  write?: (file: string, contents: string) => void;
  versionGuard?: () => Promise<string | null>;
  onFatal?: (reason: string) => void;
}): Rig => {
  const clock = options.clock ?? new FakeClock();
  const journalFile = options.journalFile ?? join(dir, "state", "journal.json");
  const journal = openJournal({
    file: journalFile,
    networkId: "stagenet",
    mode: options.config?.mode ?? "single-wallet-pinned",
    now: () => new Date(clock.now()),
    ...(options.write ? { write: options.write } : {}),
  });
  const outbox = new Outbox(join(dir, "state", "outbox"));
  const logs: Record<string, unknown>[] = [];
  const scheduler = new Scheduler({
    cfg: cfg(options.config),
    slots: options.slots,
    journal,
    outbox,
    wallets: new FakeWallets(options.wallets),
    kernel: options.kernelClient,
    clock,
    log: (fields) => logs.push(fields),
    versionGuard: options.versionGuard,
    onFatal: options.onFatal,
  });
  return { scheduler, clock, outbox, journalFile, logs };
};

const clientFor = (k: MockKernel, attempts = 3) =>
  new KernelClient({ baseUrl: k.url, sleep: async () => undefined, attempts, sameBlobRetries: 2, random: () => 0.5 });

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  test("chooseCoin: keeps the pinned coin, else the smallest eligible, never a taken or excluded one", () => {
    const a1 = coin(COLOUR_A, "A1", GIVE);
    const a2 = coin(COLOUR_A, "A2", GIVE);
    const big = coin(COLOUR_A, "big", 10n * GIVE);
    const snap = { spendable: [big, a2, a1], owned: new Set([a1.nonce, a2.nonce, big.nonce]) };
    const rec = { slot: "AB-01", giveColour: COLOUR_A, giveAmount: GIVE.toString(), coinNonce: undefined as string | undefined };
    const exact = { coinPolicy: "exact" as const, excludeNonces: new Set<string>() };
    const first = [a1, a2].sort((x, y) => x.nonce.localeCompare(y.nonce))[0]!;
    expect(chooseCoin(rec, snap, exact, new Set())?.nonce).toBe(first.nonce);
    expect(chooseCoin({ ...rec, coinNonce: a2.nonce }, snap, exact, new Set())?.nonce).toBe(a2.nonce);
    expect(chooseCoin(rec, snap, exact, new Set([a1.nonce, a2.nonce]))).toBeUndefined(); // big is not exact
    expect(chooseCoin(rec, snap, { coinPolicy: "at-least", excludeNonces: new Set() }, new Set([a1.nonce, a2.nonce]))?.nonce).toBe(big.nonce);
    expect(chooseCoin(rec, snap, { coinPolicy: "at-least", excludeNonces: new Set([big.nonce]) }, new Set([a1.nonce, a2.nonce]))).toBeUndefined();
  });

  test("retry delay doubles and is capped", () => {
    const c = cfg({ retryBaseMs: 60_000, retryMaxMs: 300_000 });
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(c, n))).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});

describe("single-wallet-pinned, outbox mode (the P3 shape)", () => {
  test("first tick: 6 offers, 6 distinct pinned coins, reserves untouched, all live in the outbox", async () => {
    const wallet = fundingWallet();
    const { scheduler, outbox } = rig({ wallets: [wallet], slots: testSlots(() => "funding") });
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 6, posted: 6, errors: 0, depleted: 0 });
    const records = scheduler.deps.journal.slots();
    expect(records.every((r) => r.state === "stored")).toBe(true);
    const nonces = records.map((r) => r.current!.coinNonce);
    expect(new Set(nonces).size).toBe(6);
    const reserves = [coin(COLOUR_B, "Breserve", 1n).nonce, coin(COLOUR_C, "Creserve", 1n).nonce];
    for (const n of reserves) expect(nonces).not.toContain(n);
    const entries = outbox.list();
    expect(entries).toHaveLength(6);
    for (const entry of entries) {
      const payload = decodeFakeOffer(entry.blob);
      expect(payload.nonce).toBe(entry.coinNonce);
      expect(payload.inputs).toEqual([entry.coinNullifier]);
      expect(payload.wantAmount).toBe(entry.wantAmount);
    }
    expect(entries.find((e) => e.slot === "AB-02")!.wantAmount).toBe("100000000");
    expect(wallet.releases).toBe(6);
  });

  test("no re-offer while live; refresh on expiry with the SAME coin and a new offer", async () => {
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding") });
    await scheduler.runTick();
    const first = new Map(scheduler.deps.journal.slots().map((r) => [r.slot, r.current!]));
    clock.advance(30 * 60_000);
    expect(await scheduler.runTick()).toMatchObject({ built: 0, expired: 0 });
    clock.advance(30 * 60_000); // exactly at expiresAt: not yet (grace)
    expect(await scheduler.runTick()).toMatchObject({ built: 0, expired: 0 });
    clock.advance(5_000);
    const refresh = await scheduler.runTick();
    expect(refresh).toMatchObject({ expired: 6, built: 6, posted: 6 });
    for (const record of scheduler.deps.journal.slots()) {
      expect(record.state).toBe("stored");
      expect(record.current!.coinNonce).toBe(first.get(record.slot)!.coinNonce);
      expect(record.current!.offerId).not.toBe(first.get(record.slot)!.offerId);
      expect(record.history.map((h) => h.outcome)).toEqual(["expired"]);
      expect(record.cycles).toBe(2);
    }
  });

  test("a consumed offer (coin spent) with no other eligible coin → depleted: terminal, not an error", async () => {
    const wallet = fundingWallet();
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding") });
    await scheduler.runTick();
    const ab02 = scheduler.deps.journal.get("AB-02")!;
    wallet.spend(ab02.current!.coinNonce); // a taker settled AB-02
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ consumed: 1, depleted: 1, errors: 0, built: 0 });
    expect(scheduler.deps.journal.get("AB-02")!.state).toBe("depleted");
    expect(scheduler.deps.journal.get("AB-02")!.history.map((h) => h.outcome)).toEqual(["consumed"]);
    for (const slot of ["AB-01", "AB-03", "BC-01", "BC-02", "BC-03"]) expect(scheduler.deps.journal.get(slot)!.state).toBe("stored");
    const builds = wallet.builds;
    const again = await scheduler.runTick();
    expect(again).toMatchObject({ depleted: 0, errors: 0, built: 0 });
    expect(wallet.builds).toBe(builds);
    expect(scheduler.deps.journal.get("AB-02")!.state).toBe("depleted");
  });

  test("an excluded nonce is never assigned", async () => {
    const wallet = fundingWallet();
    const excluded = coin(COLOUR_A, "A1", GIVE).nonce;
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding"), config: { excludeNonces: new Set([excluded]) } });
    const report = await scheduler.runTick();
    expect(report.depleted).toBe(1); // 2 A coins for 3 AB slots
    expect(scheduler.deps.journal.slots().map((r) => r.current?.coinNonce)).not.toContain(excluded);
  });

  test("a fixed coin pool (includeNonces): coins received later are never adopted", async () => {
    const wallet = fundingWallet();
    const pool = new Set(["A1", "A2", "A3", "B1", "B2", "B3"].map((l) => coin(l.startsWith("A") ? COLOUR_A : COLOUR_B, l, GIVE).nonce));
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding"), config: { includeNonces: pool } });
    await scheduler.runTick();
    const ab02 = scheduler.deps.journal.get("AB-02")!;
    // Settlement in the same wallet: AB-02's coin is spent, and the taker leg brings a NEW
    // exact-size stkA coin back into the wallet. It must not be adopted.
    wallet.spend(ab02.current!.coinNonce, coin(COLOUR_A, "received-by-taker", GIVE));
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ consumed: 1, depleted: 1, built: 0 });
    expect(scheduler.deps.journal.get("AB-02")!.state).toBe("depleted");
  });

  test("restart: a new process with the same journal posts no duplicate", async () => {
    const wallet = fundingWallet();
    const first = rig({ wallets: [wallet], slots: testSlots(() => "funding") });
    await first.scheduler.runTick();
    const builds = wallet.builds;
    const second = rig({ wallets: [wallet], slots: testSlots(() => "funding"), clock: first.clock, journalFile: first.journalFile });
    first.clock.advance(10 * 60_000);
    const report = await second.scheduler.runTick();
    expect(report).toMatchObject({ built: 0, posted: 0, errors: 0 });
    expect(wallet.builds).toBe(builds);
    expect(second.outbox.list()).toHaveLength(6);
  });
});

describe("wallet-per-slot (production shape)", () => {
  test("consumed → re-offer from the change coin; 10 fills from a 1000 coin, then depleted", async () => {
    const maker = new FakeWallet("AB-01", [coin(COLOUR_A, "inventory", 10n * GIVE)]);
    const slots = testSlots((slot) => slot).filter((s) => s.slot === "AB-01");
    const { scheduler } = rig({ wallets: [maker], slots, config: { mode: "wallet-per-slot", coinPolicy: "at-least" } });
    await scheduler.runTick();
    for (let fill = 1; fill <= 10; fill++) {
      const current = scheduler.deps.journal.get("AB-01")!.current!;
      const remaining = BigInt(current.coinValue) - GIVE;
      maker.spend(current.coinNonce, remaining > 0n ? coin(COLOUR_A, `change-${fill}`, remaining) : undefined);
      const report = await scheduler.runTick();
      expect(report.consumed).toBe(1);
      if (fill < 10) {
        expect(report.built).toBe(1);
        const next = scheduler.deps.journal.get("AB-01")!.current!;
        expect(next.coinValue).toBe(remaining.toString());
      } else {
        expect(report.depleted).toBe(1);
      }
    }
    const record = scheduler.deps.journal.get("AB-01")!;
    expect(record.state).toBe("depleted");
    expect(record.cycles).toBe(10);
    expect(record.history.filter((h) => h.outcome === "consumed")).toHaveLength(10);
  });

  test("each slot uses its own wallet and pin controller", async () => {
    const wallets = testSlots((s) => s).map((s) => new FakeWallet(s.slot, [coin(s.giveColour, `inv-${s.slot}`, 10n * GIVE)]));
    const { scheduler } = rig({ wallets, slots: testSlots((s) => s), config: { mode: "wallet-per-slot", coinPolicy: "at-least" } });
    expect(await scheduler.runTick()).toMatchObject({ built: 6, errors: 0 });
    for (const w of wallets) {
      expect(w.builds).toBe(1);
      expect(w.pins.isPinned()).toBe(false);
    }
  });
});

describe("failures", () => {
  test("a build failure → error with backoff; retried only after the backoff", async () => {
    const wallet = fundingWallet();
    wallet.failNextBuild = new Error("proof server unavailable");
    const slots = testSlots(() => "funding").slice(0, 1);
    const { scheduler, clock } = rig({ wallets: [wallet], slots });
    expect(await scheduler.runTick()).toMatchObject({ errors: 1, built: 0 });
    expect(scheduler.deps.journal.get("AB-01")!.lastError?.code).toBe("BUILD_FAILED");
    clock.advance(30_000);
    const early = await scheduler.runTick();
    expect(early.built).toBe(0);
    expect(early.slots[0]!.actions).toContain("backoff");
    clock.advance(30_000);
    expect(await scheduler.runTick()).toMatchObject({ built: 1, errors: 0 });
  });

  test("an unreadable wallet changes nothing and throws nothing", async () => {
    const wallet = fundingWallet();
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding") });
    await scheduler.runTick();
    wallet.snapshotError = new Error("indexer down");
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, consumed: 0, expired: 0, errors: 0 });
    expect(scheduler.deps.journal.slots().every((r) => r.state === "stored")).toBe(true);
  });

  test("maxBuildsPerTick defers the rest to the next tick", async () => {
    const wallet = fundingWallet();
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding"), config: { maxBuildsPerTick: 2 } });
    expect(await scheduler.runTick()).toMatchObject({ built: 2, deferred: 4 });
    expect(await scheduler.runTick()).toMatchObject({ built: 2, deferred: 2 });
    expect(await scheduler.runTick()).toMatchObject({ built: 2, deferred: 0 });
  });
});

describe("kernel mode against the mock kernel (API.md dedup: output markers only)", () => {
  test("posts 6 (submitted → live); kernel expiry → re-offer the same coin; never two live offers per coin", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding"), kernelClient: clientFor(kernel) });
    expect(await scheduler.runTick()).toMatchObject({ built: 6, posted: 6, rejected: 0 });
    expect(scheduler.deps.journal.slots().every((r) => r.state === "submitted")).toBe(true);
    expect(kernel.offers.size).toBe(6);
    const ab01 = scheduler.deps.journal.get("AB-01")!.current!;
    clock.advance(10 * 60_000);
    expect(await scheduler.runTick()).toMatchObject({ built: 0, posted: 0 });
    expect(scheduler.deps.journal.slots().every((r) => r.state === "live")).toBe(true);
    kernel.offers.get(ab01.offerId)!.status = "expired";
    expect(await scheduler.runTick()).toMatchObject({ expired: 1, built: 1, posted: 1 });
    const next = scheduler.deps.journal.get("AB-01")!.current!;
    expect(next.coinNonce).toBe(ab01.coinNonce);
    expect(next.offerId).not.toBe(ab01.offerId);
    expect([...kernel.liveByNullifier().values()].every((n) => n === 1)).toBe(true);
  });

  test("C1: a LOST journal with the kernel still holding live offers → the restart ADOPTS them: 0 duplicate live offers per coin", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const first = rig({ wallets: [wallet], slots: testSlots(() => "funding"), kernelClient: clientFor(kernel) });
    await first.scheduler.runTick();
    expect(kernel.offers.size).toBe(6);
    const builds = wallet.builds;
    const byCoin = new Map(first.scheduler.deps.journal.slots().map((r) => [r.slot, r.current!.coinNonce]));
    // The journal is lost (down -v, a new STATE_DIR, …): a fresh journal, same wallet and kernel.
    const second = rig({ wallets: [wallet], slots: testSlots(() => "funding"), kernelClient: clientFor(kernel), clock: first.clock, journalFile: join(dir, "other", "journal.json") });
    const report = await second.scheduler.runTick();
    expect(report).toMatchObject({ adopted: 6, built: 0, posted: 0 });
    expect(wallet.builds).toBe(builds);
    expect(kernel.offers.size).toBe(6);
    expect([...kernel.liveByNullifier().values()].every((n) => n === 1)).toBe(true);
    for (const record of second.scheduler.deps.journal.slots()) {
      expect(record.state).toBe("submitted"); // adopted offers are verified like our own (F-B21)
      expect(record.current!.coinNonce).toBe(byCoin.get(record.slot)!); // each slot adopts its own offer (legs match)
    }
    await second.scheduler.runTick();
    expect(second.scheduler.deps.journal.slots().every((r) => r.state === "live")).toBe(true);
    expect([...kernel.liveByNullifier().values()].every((n) => n === 1)).toBe(true);
  });

  test("C1: without the kernel's live list, nothing new is built (cannot prove the coin is free)", async () => {
    kernel = new MockKernel().start();
    kernel.listUnavailable = true;
    const wallet = fundingWallet();
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding"), kernelClient: clientFor(kernel, 1) });
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, posted: 0 });
    expect(report.slots.every((r) => r.actions.includes("kernel-live-unknown"))).toBe(true);
  });

  test("C1: a coin held by a kernel offer with OTHER legs is not built on (waits)", async () => {
    kernel = new MockKernel().start();
    const wallet = new FakeWallet("funding", [coin(COLOUR_A, "A1", GIVE)]);
    const target = coin(COLOUR_A, "A1", GIVE);
    kernel.offers.set("e".repeat(64), { offerId: "e".repeat(64), blob: "x", nullifiers: [target.nullifier], outputs: [], give: COLOUR_A, giveAmount: GIVE.toString(), want: COLOUR_B, wantAmount: "1", status: "live", postedAt: 0 });
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, adopted: 0, depleted: 0 });
    expect(report.slots[0]!.actions).toContain("coins-held-by-kernel");
  });

  test("C7: outbox → kernel switch publishes the stored blobs at once (same bytes, no rebuild)", async () => {
    const wallet = fundingWallet();
    const first = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2) });
    await first.scheduler.runTick();
    const stored = first.scheduler.deps.journal.slots().map((r) => r.current!.blobSha256);
    const builds = wallet.builds;
    kernel = new MockKernel().start();
    const second = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), kernelClient: clientFor(kernel), clock: first.clock, journalFile: first.journalFile });
    const report = await second.scheduler.runTick();
    expect(report).toMatchObject({ built: 0, posted: 2 });
    expect(wallet.builds).toBe(builds);
    expect(second.scheduler.deps.journal.slots().map((r) => r.state)).toEqual(["submitted", "submitted"]);
    expect(second.scheduler.deps.journal.slots().map((r) => r.current!.blobSha256)).toEqual(stored);
  });

  test("C7: a live offer the kernel reports not_found is re-posted (same blob), not rebuilt", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    await scheduler.runTick();
    clock.advance(60_000);
    await scheduler.runTick(); // → live
    const current = scheduler.deps.journal.get("AB-01")!.current!;
    kernel.offers.delete(current.offerId); // the kernel lost it
    const builds = wallet.builds;
    clock.advance(60_000);
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, posted: 1 });
    expect(wallet.builds).toBe(builds);
    expect(kernel.offers.has(current.offerId)).toBe(true);
  });

  test("C7: no rebuild while the old offer may still be valid (local TTL passed, root window not)", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({
      wallets: [wallet],
      slots: testSlots(() => "funding").slice(0, 1),
      kernelClient: clientFor(kernel),
      config: { offerTtlMs: 5 * 60_000, rootWindowMs: HOUR },
    });
    await scheduler.runTick();
    const first = scheduler.deps.journal.get("AB-01")!.current!;
    clock.advance(10 * 60_000); // local TTL (5 min) passed; the kernel still says live
    expect(await scheduler.runTick()).toMatchObject({ built: 0, expired: 0 });
    kernel.offers.delete(first.offerId); // even not_found inside the root window → re-post, not rebuild
    expect(await scheduler.runTick()).toMatchObject({ built: 0, expired: 0, posted: 1 });
    clock.advance(HOUR);
    kernel.offers.delete(first.offerId);
    expect(await scheduler.runTick()).toMatchObject({ expired: 1, built: 1 });
  });

  test("C7: OFFER_ID_MISMATCH halts the slot and KEEPS the coin claimed", async () => {
    kernel = new MockKernel().start();
    kernel.script.push({ status: 200, body: { success: true, offerId: "f".repeat(64) } });
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    await scheduler.runTick();
    const record = scheduler.deps.journal.get("AB-01")!;
    expect(record.state).toBe("halted");
    expect(record.lastError?.code).toBe("OFFER_ID_MISMATCH");
    expect(scheduler.deps.journal.claimedNonces().has(record.current!.coinNonce)).toBe(true);
    clock.advance(2 * HOUR);
    expect(await scheduler.runTick()).toMatchObject({ built: 0, posted: 0 });
  });

  test("C7: when the kernel first lists an offer live, its inputNullifiers must be exactly the pinned coin, else halt", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), kernelClient: clientFor(kernel) });
    await scheduler.runTick();
    const ab01 = scheduler.deps.journal.get("AB-01")!.current!;
    const held = kernel.offers.get(ab01.offerId)!;
    kernel.offers.set(ab01.offerId, { ...held, nullifiers: ["ff".repeat(32)] });
    clock.advance(60_000);
    await scheduler.runTick();
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("halted");
    expect(scheduler.deps.journal.get("AB-01")!.lastError?.code).toBe("INPUT_NULLIFIER_MISMATCH");
    expect(scheduler.deps.journal.get("AB-02")!.state).toBe("live");
  });

  test("crash between build and ack: the restart re-posts the SAME blob (no second build)", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const slots = testSlots(() => "funding").slice(0, 2);
    kernel.script.push({ status: 503, body: "down" }, { status: 503, body: "down" });
    const first = rig({ wallets: [wallet], slots, kernelClient: clientFor(kernel, 1) });
    expect(await first.scheduler.runTick()).toMatchObject({ built: 2, posted: 0 });
    expect(first.scheduler.deps.journal.slots().map((r) => r.state)).toEqual(["stored", "stored"]);
    const blobs = new Map(first.scheduler.deps.journal.slots().map((r) => [r.slot, r.current!.blobSha256]));
    const builds = wallet.builds;
    const second = rig({ wallets: [wallet], slots, kernelClient: clientFor(kernel), clock: first.clock, journalFile: first.journalFile });
    expect(await second.scheduler.runTick()).toMatchObject({ built: 0, posted: 2 });
    expect(wallet.builds).toBe(builds);
    for (const record of second.scheduler.deps.journal.slots()) {
      expect(record.state).toBe("submitted");
      expect(record.current!.blobSha256).toBe(blobs.get(record.slot)!);
    }
    expect(kernel.offers.size).toBe(2);
  });

  test("lost ack (kernel stored it, answered 5xx): next tick sees it live, no re-post", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const client = clientFor(kernel, 1);
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: client });
    const originalPost = client.postOffer.bind(client);
    let first = true;
    client.postOffer = async (blob: string) => {
      if (first) {
        first = false;
        await originalPost(blob);
        return { kind: "unavailable", status: 502, error: "502 bad gateway", attempts: 1 };
      }
      return await originalPost(blob);
    };
    expect(await scheduler.runTick()).toMatchObject({ built: 1, posted: 0 });
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("stored");
    expect(await scheduler.runTick()).toMatchObject({ built: 0 });
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("live");
    expect(kernel.offers.size).toBe(1);
  });

  test("409 conflict: rejected with its code, never re-sent; rebuilt only after the backoff", async () => {
    kernel = new MockKernel().start();
    kernel.script.push({ status: 409, body: { error: "DUPLICATE_MARKERS" } }, { status: 409, body: { error: "DUPLICATE_MARKERS" } });
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    expect(await scheduler.runTick()).toMatchObject({ built: 1, rejected: 1, posted: 0 });
    let record = scheduler.deps.journal.get("AB-01")!;
    expect(record.state).toBe("rejected");
    expect(record.lastError?.code).toBe("DUPLICATE_MARKERS");
    expect(kernel.posts).toHaveLength(1);
    clock.advance(59_000);
    expect(await scheduler.runTick()).toMatchObject({ built: 0 });
    expect(kernel.posts).toHaveLength(1);
    clock.advance(2_000);
    expect(await scheduler.runTick()).toMatchObject({ built: 1, rejected: 1 });
    expect(new Set(kernel.posts).size).toBe(2); // a NEW blob, not the refused one
    record = scheduler.deps.journal.get("AB-01")!;
    expect(record.consecutiveFailures).toBe(2);
    expect(Date.parse(record.nextAttemptAt!) - clock.now()).toBe(120_000);
  });

  test("422 malformed is journaled and not retried blindly; NULLIFIER_SPENT → consumed", async () => {
    kernel = new MockKernel().start();
    kernel.script.push({ status: 422, body: { error: "MALFORMED" } }, { status: 400, body: { error: "NULLIFIER_SPENT" } });
    const wallet = fundingWallet();
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), kernelClient: clientFor(kernel) });
    expect(await scheduler.runTick()).toMatchObject({ built: 2, rejected: 1, consumed: 1 });
    expect(scheduler.deps.journal.get("AB-01")!.lastError?.code).toBe("MALFORMED");
    expect(scheduler.deps.journal.get("AB-02")!.state).toBe("consumed");
    expect(kernel.posts).toHaveLength(2);
  });

  test("5xx then accept: retried with the same blob inside one post", async () => {
    kernel = new MockKernel().start();
    kernel.script.push({ status: 500, body: "boom" }, { status: 502, body: "bad" });
    const wallet = fundingWallet();
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    expect(await scheduler.runTick()).toMatchObject({ built: 1, posted: 1 });
    expect(kernel.posts).toHaveLength(3);
    expect(new Set(kernel.posts).size).toBe(1);
  });
});

describe("audit fixes: persistence, timeouts, version guard", () => {
  test("C3: a failed journal write leaves no memory-only claim; the recipe is released; recovery re-offers without a restart", async () => {
    const wallet = fundingWallet();
    let failWrites = false;
    const write = (file: string, contents: string) => {
      if (failWrites) throw new Error("ENOSPC: no space left on device");
      writeAtomic(file, contents);
    };
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), write });
    failWrites = true;
    const report = await scheduler.runTick();
    expect(report.built).toBe(1);
    expect(report.slots[0]!.actions).toContain("persist-failed");
    expect(report.slots[1]!.actions).toContain("publish-blocked"); // publication stops for the tick
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("idle"); // memory unchanged
    expect(scheduler.deps.journal.claimedNonces().size).toBe(0);
    expect(wallet.releases).toBe(1);
    failWrites = false;
    const after = await scheduler.runTick();
    expect(after).toMatchObject({ built: 2, errors: 0 });
    expect(scheduler.deps.journal.slots().map((r) => r.state)).toEqual(["stored", "stored"]);
  });

  test("C6: a hung build times out, the slot errors, and the process is asked to exit", async () => {
    const wallet = fundingWallet();
    wallet.build = () => new Promise(() => undefined); // proving never returns
    const fatal: string[] = [];
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), config: { buildTimeoutMs: 30 }, onFatal: (r) => fatal.push(r) });
    const report = await scheduler.runTick();
    expect(scheduler.deps.journal.get("AB-01")!.lastError?.code).toBe("BUILD_TIMEOUT");
    expect(fatal).toHaveLength(1);
    expect(scheduler.stopping).toBe(true);
    expect(report.slots).toHaveLength(1); // stops after the current slot
  });

  test("C12: a node-version mismatch halts all building and posting, and fails /health", async () => {
    const wallet = fundingWallet();
    let version: string | null = "node version 2.0.1 != pinned 2.0.0-d9729c13";
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), versionGuard: async () => version, config: { versionCheckEveryTicks: 1 } });
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, halted: version });
    const source = {
      journal: scheduler.deps.journal,
      startedAt: clock.now(),
      delivery: "outbox" as const,
      mode: "single-wallet-pinned",
      lastTickEndedAt: () => scheduler.lastProgressAt,
      haltReason: () => scheduler.haltReason,
      inventory: () => undefined,
      now: () => clock.now(),
    };
    expect(isHealthy(source, 600_000)).toBe(false);
    version = null;
    expect(await scheduler.runTick()).toMatchObject({ built: 2 });
    expect(isHealthy(source, 600_000)).toBe(true);
  });

  test("C6: /health fails when every slot is in error", async () => {
    const wallet = fundingWallet();
    wallet.build = async () => {
      throw new Error("proof server down");
    };
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2) });
    await scheduler.runTick();
    const source = {
      journal: scheduler.deps.journal,
      startedAt: clock.now(),
      delivery: "outbox" as const,
      mode: "single-wallet-pinned",
      lastTickEndedAt: () => scheduler.lastProgressAt,
      inventory: () => undefined,
      now: () => clock.now(),
    };
    expect(scheduler.deps.journal.slots().every((r) => r.state === "error")).toBe(true);
    expect(isHealthy(source, 600_000)).toBe(false);
  });
});

describe("second audit pass (verification findings)", () => {
  test("F-B15: a fresh journal without FRESH_START_ACK builds and adopts nothing, and /health fails", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), kernelClient: clientFor(kernel), config: { freshStartAck: false } });
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, adopted: 0, posted: 0 });
    expect(report.slots.every((r) => r.actions.includes("fresh-journal-unacknowledged"))).toBe(true);
    expect(kernel.posts).toHaveLength(0);
    const source = { journal: scheduler.deps.journal, startedAt: clock.now(), delivery: "kernel" as const, mode: "m", lastTickEndedAt: () => clock.now(), inventory: () => undefined, now: () => clock.now() };
    expect(isHealthy(source, 600_000)).toBe(false);
  });

  test("F-B15: delayed indexing — an accepted but not yet listed offer + a lost journal: nothing is built without the operator's ack", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const first = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    await first.scheduler.runTick();
    for (const offer of kernel.offers.values()) offer.status = "unknown" as never; // accepted, not indexed as live yet
    const second = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel), clock: first.clock, journalFile: join(dir, "lost", "journal.json"), config: { freshStartAck: false } });
    expect(await second.scheduler.runTick()).toMatchObject({ built: 0, posted: 0 });
    expect(kernel.offers.size).toBe(1);
  });

  test("F-B14: switching to kernel mode does not publish a stored offer whose coin a DIFFERENT live offer already spends", async () => {
    const wallet = fundingWallet();
    const first = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2) });
    await first.scheduler.runTick();
    const ab01 = first.scheduler.deps.journal.get("AB-01")!.current!;
    kernel = new MockKernel().start();
    kernel.offers.set("d".repeat(64), { offerId: "d".repeat(64), blob: "x", nullifiers: [ab01.coinNullifier], outputs: [], give: COLOUR_A, giveAmount: GIVE.toString(), want: COLOUR_B, wantAmount: "80000000", status: "live", postedAt: 0 });
    const second = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), kernelClient: clientFor(kernel), clock: first.clock, journalFile: first.journalFile });
    const report = await second.scheduler.runTick();
    expect(report.slots[0]!.actions).toContain("coin-held-by-other-offer");
    expect(second.scheduler.deps.journal.get("AB-01")!.state).toBe("stored"); // claim kept, not published
    expect(second.scheduler.deps.journal.get("AB-02")!.state).toBe("submitted");
    expect(kernel.liveByNullifier().get(ab01.coinNullifier)).toBe(1);
  });

  test("F-B21: an unreadable first-live check stays pending; a later wrong read halts", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const client = clientFor(kernel);
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: client });
    await scheduler.runTick();
    const original = client.offerNullifiers.bind(client);
    client.offerNullifiers = async () => undefined;
    clock.advance(60_000);
    const pending = await scheduler.runTick();
    expect(pending.slots[0]!.actions).toContain("verify-pending");
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("submitted");
    client.offerNullifiers = async () => ["ee".repeat(32)];
    clock.advance(60_000);
    await scheduler.runTick();
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("halted");
    client.offerNullifiers = original;
  });

  test("F-B19: a halted slot fails /health and shows on /status", async () => {
    kernel = new MockKernel().start();
    kernel.script.push({ status: 200, body: { success: true, offerId: "f".repeat(64) } });
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 2), kernelClient: clientFor(kernel) });
    await scheduler.runTick();
    expect(scheduler.deps.journal.get("AB-01")!.state).toBe("halted");
    const source = { journal: scheduler.deps.journal, startedAt: clock.now(), delivery: "kernel" as const, mode: "m", lastTickEndedAt: () => clock.now(), inventory: () => undefined, now: () => clock.now() };
    expect(isHealthy(source, 600_000)).toBe(false);
    const server = startStatusServer(source, { port: 0, hostname: "127.0.0.1", staleAfterMs: 600_000 });
    try {
      const status = (await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as { haltedSlots: { slot: string; code: string }[] };
      expect(status.haltedSlots).toEqual([{ slot: "AB-01", code: "OFFER_ID_MISMATCH" }]);
      expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(503);
    } finally {
      await server.stop();
    }
  });

  test("F-B24: a failing first version check is a barrier until a check succeeds", async () => {
    const wallet = fundingWallet();
    let fail = true;
    const { scheduler } = rig({
      wallets: [wallet],
      slots: testSlots(() => "funding").slice(0, 1),
      versionGuard: async () => {
        if (fail) throw new Error("fetch failed");
        return null;
      },
      config: { versionCheckEveryTicks: 10 },
    });
    const first = await scheduler.runTick();
    expect(first.built).toBe(0);
    expect(first.halted).toMatch(/unverified/);
    fail = false;
    const second = await scheduler.runTick(); // re-checked while halted, although not a 10th tick
    expect(second.built).toBe(1);
    expect(scheduler.haltReason).toBeUndefined();
  });

  test("F-B16: a build timeout signals fatal even when the journal write then fails", async () => {
    const wallet = fundingWallet();
    wallet.build = () => new Promise(() => undefined);
    let failWrites = false;
    const write = (file: string, contents: string) => {
      if (failWrites) throw new Error("EIO");
      writeAtomic(file, contents);
    };
    const fatal: string[] = [];
    const { scheduler } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), config: { buildTimeoutMs: 20 }, onFatal: (r) => fatal.push(r), write });
    failWrites = true;
    await scheduler.runTick();
    expect(fatal).toHaveLength(1);
  });

  test("root-expiry premise: an UNKNOWN kernel status never frees the coin, even past the root window", async () => {
    kernel = new MockKernel().start();
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding").slice(0, 1), kernelClient: clientFor(kernel) });
    await scheduler.runTick();
    const current = scheduler.deps.journal.get("AB-01")!.current!;
    kernel.offers.get(current.offerId)!.status = "weird" as never; // maps to unknown
    clock.advance(3 * HOUR);
    const report = await scheduler.runTick();
    expect(report).toMatchObject({ built: 0, expired: 0 });
    expect(report.slots[0]!.actions).toContain("status-unknown");
  });
});

describe("status", () => {
  test("/health carries no data; /status has the slot table and no secrets", async () => {
    const wallet = fundingWallet();
    const { scheduler, clock } = rig({ wallets: [wallet], slots: testSlots(() => "funding") });
    await scheduler.runTick();
    const source = {
      journal: scheduler.deps.journal,
      startedAt: clock.now(),
      delivery: "outbox" as const,
      mode: "single-wallet-pinned",
      lastTickEndedAt: () => scheduler.lastProgressAt,
      inventory: (slot: string) => scheduler.inventory(slot),
      now: () => clock.now(),
    };
    const rows = statusRows(source);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ slot: "AB-01", ladder: "AB", price: "0.800", walletId: "funding", state: "stored" });
    expect(rows[0]!.offerId).toMatch(/^[0-9a-f]{64}$/);
    expect(isHealthy(source, 180_000)).toBe(true);
    clock.advance(200_000);
    expect(isHealthy(source, 180_000)).toBe(false);
    clock.advance(-200_000);
    const server = startStatusServer(source, { port: 0, hostname: "127.0.0.1", staleAfterMs: 180_000 });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");
      const status = (await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as { slots: unknown[]; states: Record<string, number> };
      expect(status.slots).toHaveLength(6);
      expect(status.states["stored"]).toBe(6);
      const text = JSON.stringify(status);
      expect(text).not.toMatch(/mnemonic|secret|seed/iu);
    } finally {
      await server.stop();
    }
  });
});
