/**
 * The ladder scheduler: one reconcile tick over every slot, and the loop around it.
 *
 * Per slot, in ladder order:
 *
 *   reconcile  posting/live → consumed  when the pinned coin is no longer owned by the
 *                                       wallet (spent on chain), or the kernel says so and
 *                                       the wallet agrees;
 *                           → expired   when the kernel says so, or (outbox mode, or the
 *                                       kernel does not know it) now ≥ expiresAt + grace;
 *              posting      → live      when the kernel accepts the stored blob (re-posted
 *                                       as-is after a crash), or at once in outbox mode.
 *   offer      idle / consumed / expired / rejected / error (after its backoff)
 *                → choose a coin: the slot's pinned coin if still spendable, else the
 *                  smallest eligible unclaimed coin of the give colour; none → depleted
 *                → build (pinned, asserted) → outbox → journal `posting` → release the
 *                  wallet's local reservation → post (kernel) or live (outbox).
 *
 * Invariants:
 * - a slot in `posting`/`live` is never re-offered ("re-offer on expiry and not before");
 * - no coin is claimed by two outstanding offers (journal-enforced);
 * - a kernel refusal is journaled with its code and retried only after a backoff, by
 *   building a NEW offer; the refused blob is never re-sent;
 * - `depleted` is terminal for the process and is not an error;
 * - one build at a time (proof-server capacity).
 *
 * Everything is injected (clock, journal, outbox, wallets, kernel), so the logic runs in
 * unit tests without a network. Decisions adapted from `zswap-offerfiles-kernel` @ 67db767
 * `deploy/scripts/lib/poster-tick.ts` / `poster-scheduler.ts` (Apache-2.0).
 *
 * @module
 */
import type { CoinPolicy } from "./ladder.ts";
import { type Journal, JournalError, REOFFER_STATES, type SlotDefinition, type SlotRecord } from "./journal.ts";
import type { KernelOfferStatus, PostOutcome } from "./kernel-client.ts";
import type { BuildOfferArgs, BuiltOffer, CoinRef } from "./offer-builder.ts";
import { blobSha256, type Outbox, type OutboxEntry } from "./outbox.ts";
import { redact } from "./redact.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface WalletSnapshot {
  /** Spendable shielded coins (not held by a pending local spend). */
  readonly spendable: readonly CoinRef[];
  /** Every nonce the wallet still owns (spendable or pending). A missing nonce = spent. */
  readonly owned: ReadonlySet<string>;
}

export interface LadderWallet {
  readonly walletId: string;
  snapshot(): Promise<WalletSnapshot>;
  build(args: BuildOfferArgs): Promise<BuiltOffer>;
  /** Release the wallet's local reservation of a stored offer (plan Q5). */
  release(recipe: unknown): Promise<void>;
}

export interface WalletPort {
  get(walletId: string): Promise<LadderWallet>;
}

/** A live offer as the kernel lists it (`GET /v1/offers?token=…&direction=GIVING`). */
export interface KernelLiveOffer {
  readonly offerId: string;
  readonly inputNullifiers: readonly string[];
  readonly expiresAt?: string | undefined;
  readonly gives?: readonly { token: string; amount: string }[] | undefined;
  readonly wants?: readonly { token: string; amount: string }[] | undefined;
}

/** Does a kernel offer have exactly this slot's legs (so the slot may adopt it)? */
export const offerMatchesSlot = (offer: KernelLiveOffer, record: Pick<SlotRecord, "giveColour" | "giveAmount" | "wantColour" | "wantAmount">): boolean =>
  offer.gives?.length === 1 &&
  offer.wants?.length === 1 &&
  offer.gives[0]!.token.toLowerCase() === record.giveColour &&
  offer.gives[0]!.amount === record.giveAmount &&
  offer.wants[0]!.token.toLowerCase() === record.wantColour &&
  offer.wants[0]!.amount === record.wantAmount;

export interface KernelPort {
  postOffer(blob: string): Promise<PostOutcome>;
  offerStatus(offerId: string): Promise<KernelOfferStatus>;
  /** Every live offer giving one of `colours` (audit C1: adopt before posting). */
  liveOffers(colours: readonly string[]): Promise<KernelLiveOffer[]>;
  /** The `swapoffer1…` string of an offer the kernel holds, if any. */
  offerBlob(offerId: string): Promise<string | undefined>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }),
};

export type LogFields = Record<string, unknown> & { phase: string };
export type Log = (fields: LogFields) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  readonly networkId: string;
  readonly mode: string;
  readonly coinPolicy: CoinPolicy;
  readonly offerTtlMs: number;
  /** Wait this long past `expiresAt` before treating an offer as expired locally. */
  readonly expiryGraceMs: number;
  /** First retry delay after a refusal or failure; doubles per consecutive failure. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly excludeNonces: ReadonlySet<string>;
  /** If set, the only nonces a slot may be given (a fixed coin pool). */
  readonly includeNonces?: ReadonlySet<string> | undefined;
  /** Builds per tick (default: unlimited). */
  readonly maxBuildsPerTick: number;
  /** Outbox entries of ended offers are removed after this long. */
  readonly outboxRetentionMs: number;
  /**
   * The node's Merkle-root window (audit C1/C7): an offer is proven dead only when the
   * kernel says so, or when `builtAt + rootWindowMs + expiryGraceMs` has passed. A coin is
   * never re-offered before that.
   */
  readonly rootWindowMs: number;
  /** Re-post a `submitted` offer the kernel still does not know after this long. */
  readonly submitConfirmMs: number;
  /** A build (proof) that takes longer is abandoned and the process asked to exit. */
  readonly buildTimeoutMs: number;
  /** Check the node version every N ticks (0 = only the first tick). */
  readonly versionCheckEveryTicks: number;
}

export interface SlotPlan extends SlotDefinition {
  readonly priceText?: string;
}

export interface SchedulerDeps {
  readonly cfg: SchedulerConfig;
  readonly slots: readonly SlotPlan[];
  readonly journal: Journal;
  readonly outbox: Outbox;
  readonly wallets: WalletPort;
  /** Undefined = outbox mode. */
  readonly kernel?: KernelPort | undefined;
  readonly clock: Clock;
  readonly log: Log;
  /** Returns a problem string when the node/ledger version is not the pinned one (audit C12). */
  readonly versionGuard?: (() => Promise<string | null>) | undefined;
  /** Called when the process should exit so its restart policy recovers (audit C6). */
  readonly onFatal?: ((reason: string) => void) | undefined;
}

/** Reject after `ms` with a `TimeoutError` (the underlying work cannot be cancelled). */
export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms} ms`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface SlotReport {
  readonly slot: string;
  readonly before: string;
  readonly after: string;
  readonly actions: readonly string[];
  readonly offerId?: string;
  readonly inventory?: { coins: number; value: string };
}

export interface TickReport {
  readonly tick: number;
  readonly startedAt: string;
  readonly ms: number;
  readonly built: number;
  readonly posted: number;
  readonly consumed: number;
  readonly expired: number;
  readonly rejected: number;
  readonly errors: number;
  readonly depleted: number;
  readonly deferred: number;
  readonly adopted: number;
  readonly halted?: string;
  readonly slots: readonly SlotReport[];
}

const short = (hex: string | undefined): string | undefined => (hex === undefined ? undefined : `${hex.slice(0, 12)}…`);
const message = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export function retryDelayMs(cfg: SchedulerConfig, consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** (n - 1));
}

/** Pure: which coin should `record` offer next? `undefined` = none eligible (depleted). */
export function chooseCoin(
  record: Pick<SlotRecord, "slot" | "giveColour" | "giveAmount" | "coinNonce">,
  snapshot: WalletSnapshot,
  cfg: Pick<SchedulerConfig, "coinPolicy" | "excludeNonces" | "includeNonces">,
  taken: ReadonlySet<string>,
): CoinRef | undefined {
  const give = BigInt(record.giveAmount);
  const valueOk = (value: bigint): boolean => (cfg.coinPolicy === "exact" ? value === give : value >= give);
  const eligible = (coin: CoinRef): boolean =>
    coin.type === record.giveColour &&
    !cfg.excludeNonces.has(coin.nonce) &&
    (cfg.includeNonces === undefined || cfg.includeNonces.has(coin.nonce)) &&
    !taken.has(coin.nonce) &&
    valueOk(coin.value);
  if (record.coinNonce !== undefined) {
    const same = snapshot.spendable.find((coin) => coin.nonce === record.coinNonce);
    if (same !== undefined && eligible(same)) return same;
  }
  return [...snapshot.spendable]
    .filter(eligible)
    .sort((a, b) => (a.value === b.value ? a.nonce.localeCompare(b.nonce) : a.value < b.value ? -1 : 1))[0];
}

/** Remaining inventory of a slot: eligible, unclaimed give coins in its wallet. */
export function inventoryOf(
  record: Pick<SlotRecord, "giveColour" | "giveAmount">,
  snapshot: WalletSnapshot,
  cfg: Pick<SchedulerConfig, "coinPolicy" | "excludeNonces" | "includeNonces">,
): { coins: number; value: bigint } {
  const give = BigInt(record.giveAmount);
  let coins = 0;
  let value = 0n;
  for (const coin of snapshot.spendable) {
    if (coin.type !== record.giveColour || cfg.excludeNonces.has(coin.nonce)) continue;
    if (cfg.includeNonces !== undefined && !cfg.includeNonces.has(coin.nonce)) continue;
    if (cfg.coinPolicy === "exact" ? coin.value !== give : coin.value < give) continue;
    coins += 1;
    value += coin.value;
  }
  return { coins, value };
}

export class Scheduler {
  readonly deps: SchedulerDeps;
  #tick = 0;
  #stopping = false;
  #lastReport: TickReport | undefined;
  #lastTickEndedAt: number | undefined;
  #lastProgressAt: number | undefined;
  #inventory = new Map<string, { coins: number; value: bigint }>();
  #haltReason: string | undefined;
  #kernelLive: Map<string, KernelLiveOffer> | Error | undefined;
  #publishBlocked: string | undefined;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    for (const slot of deps.slots) deps.journal.ensureSlot(slot);
  }

  get lastReport(): TickReport | undefined {
    return this.#lastReport;
  }

  get lastTickEndedAt(): number | undefined {
    return this.#lastTickEndedAt;
  }

  /** Last time a slot finished processing or a tick ended (for `/health` during long ticks). */
  get lastProgressAt(): number | undefined {
    return this.#lastProgressAt;
  }

  /** Set when the node/ledger version guard failed (audit C12): nothing is built or posted. */
  get haltReason(): string | undefined {
    return this.#haltReason;
  }

  inventory(slot: string): { coins: number; value: bigint } | undefined {
    return this.#inventory.get(slot);
  }

  /** Ask the loop (and a running tick, between slots) to stop. */
  stop(): void {
    this.#stopping = true;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  async runTick(): Promise<TickReport> {
    const { cfg, journal, clock, log } = this.deps;
    const tick = ++this.#tick;
    const startedAt = clock.now();
    const counts = { built: 0, posted: 0, consumed: 0, expired: 0, rejected: 0, errors: 0, depleted: 0, deferred: 0, adopted: 0 };
    const snapshots = new Map<string, WalletSnapshot | Error>();
    const reports: SlotReport[] = [];
    log({ phase: "tick-start", tick, slots: this.deps.slots.length, delivery: this.deps.kernel ? "kernel" : "outbox" });

    const snapshotOf = async (walletId: string): Promise<WalletSnapshot | Error> => {
      const cached = snapshots.get(walletId);
      if (cached !== undefined) return cached;
      let result: WalletSnapshot | Error;
      try {
        const wallet = await this.deps.wallets.get(walletId);
        result = await wallet.snapshot();
      } catch (error) {
        result = error instanceof Error ? error : new Error(String(error));
        log({ phase: "wallet", tick, walletId, result: "unreadable", detail: message(error) });
      }
      snapshots.set(walletId, result);
      return result;
    };

    // Audit C12: the node/ledger version guard. On a mismatch nothing is built or posted.
    if (this.deps.versionGuard && (tick === 1 || (cfg.versionCheckEveryTicks > 0 && tick % cfg.versionCheckEveryTicks === 0))) {
      try {
        const problem = await this.deps.versionGuard();
        if (problem !== this.#haltReason) log({ phase: "version", tick, result: problem === null ? "ok" : "halt", detail: problem ?? undefined });
        this.#haltReason = problem ?? undefined;
      } catch (error) {
        log({ phase: "version", tick, result: "unreadable", detail: message(error) });
      }
    }
    // Audit C1: in kernel mode, learn which coins the kernel already has live offers for,
    // so a lost or fresh journal adopts them instead of posting twins.
    this.#kernelLive = undefined;
    this.#publishBlocked = undefined;
    if (this.deps.kernel && this.#haltReason === undefined) {
      try {
        const colours = [...new Set(this.deps.slots.map((s) => s.giveColour))];
        const live = await this.deps.kernel.liveOffers(colours);
        this.#kernelLive = new Map<string, KernelLiveOffer>();
        for (const offer of live) for (const n of offer.inputNullifiers) this.#kernelLive.set(n.toLowerCase(), offer);
      } catch (error) {
        this.#kernelLive = error instanceof Error ? error : new Error(String(error));
        log({ phase: "kernel-live", tick, result: "unreadable", detail: message(error) });
      }
    }

    for (const plan of this.deps.slots) {
      if (this.#stopping) break;
      if (this.#haltReason !== undefined) {
        reports.push({ slot: plan.slot, before: journal.get(plan.slot)!.state, after: journal.get(plan.slot)!.state, actions: ["halted:version"] });
        continue;
      }
      const actions: string[] = [];
      const before = journal.get(plan.slot)!.state;
      try {
        await this.#reconcile(plan.slot, tick, snapshotOf, actions, counts);
        const record = journal.get(plan.slot)!;
        const snap = await snapshotOf(record.walletId);
        if (!(snap instanceof Error)) {
          const inv = inventoryOf(record, snap, cfg);
          this.#inventory.set(plan.slot, inv);
        }
        if (REOFFER_STATES.includes(record.state)) {
          const due = record.nextAttemptAt === undefined || clock.now() >= Date.parse(record.nextAttemptAt);
          if (!due) {
            actions.push("backoff");
          } else if (counts.built >= cfg.maxBuildsPerTick) {
            actions.push("deferred");
            counts.deferred += 1;
          } else if (!(snap instanceof Error)) {
            await this.#offer(record, snap, tick, actions, counts);
            snapshots.delete(record.walletId); // the wallet changed; re-read for the next slot
          } else {
            actions.push("wallet-unreadable");
          }
        }
      } catch (error) {
        // A bug or an unexpected journal refusal: surface it, never loop on it silently.
        counts.errors += 1;
        actions.push(`exception:${redact(message(error)).slice(0, 120)}`);
        log({ phase: "slot", tick, slot: plan.slot, result: "exception", detail: redact(message(error)) });
      }
      this.#lastProgressAt = clock.now();
      const after = journal.get(plan.slot)!;
      const inv = this.#inventory.get(plan.slot);
      reports.push({
        slot: plan.slot,
        before,
        after: after.state,
        actions,
        ...(after.current ? { offerId: after.current.offerId } : {}),
        ...(inv ? { inventory: { coins: inv.coins, value: inv.value.toString() } } : {}),
      });
    }

    // Outbox housekeeping: keep every current offer; drop ended ones past retention.
    const keep = new Set<string>();
    for (const record of journal.slots()) if (record.current) keep.add(record.current.offerId);
    try {
      const removed = this.deps.outbox.prune(keep, cfg.outboxRetentionMs, clock.now());
      if (removed.length > 0) log({ phase: "outbox-prune", tick, removed: removed.length });
    } catch (error) {
      log({ phase: "outbox-prune", tick, result: "error", detail: message(error) });
    }

    const report: TickReport = {
      tick,
      startedAt: new Date(startedAt).toISOString(),
      ms: clock.now() - startedAt,
      ...counts,
      ...(this.#haltReason !== undefined ? { halted: this.#haltReason } : {}),
      slots: reports,
    };
    this.#lastReport = report;
    this.#lastTickEndedAt = clock.now();
    this.#lastProgressAt = this.#lastTickEndedAt;
    log({ phase: "tick-end", tick, ms: report.ms, ...counts, states: JSON.stringify(journal.summary().byState) });
    return report;
  }

  /** A coin's previous offer is proven dead only at this time (audit C1/C7). */
  #deadAt(current: { builtAt: string; expiresAt: string }): number {
    const { cfg } = this.deps;
    return Math.max(Date.parse(current.expiresAt), Date.parse(current.builtAt) + cfg.rootWindowMs) + cfg.expiryGraceMs;
  }

  async #reconcile(
    slot: string,
    tick: number,
    snapshotOf: (walletId: string) => Promise<WalletSnapshot | Error>,
    actions: string[],
    counts: { consumed: number; expired: number; posted: number; rejected: number; errors: number },
  ): Promise<void> {
    const { cfg, journal, clock, log, kernel } = this.deps;
    const record = journal.get(slot)!;
    if (record.state === "halted") {
      actions.push("halted");
      return;
    }
    if (record.state !== "stored" && record.state !== "submitted" && record.state !== "live") return;
    const current = record.current!;
    const snap = await snapshotOf(record.walletId);
    if (snap instanceof Error) {
      actions.push("wallet-unreadable");
      return;
    }
    // The wallet is the proof: a pinned coin it no longer owns was spent on chain.
    if (!snap.owned.has(current.coinNonce)) {
      journal.endOffer(slot, "consumed", { code: "COIN_SPENT" });
      counts.consumed += 1;
      actions.push("consumed");
      log({ phase: "reconcile", tick, slot, offerId: short(current.offerId), result: "consumed", reason: "coin_spent" });
      return;
    }
    const now = clock.now();
    const dead = now >= this.#deadAt(current);
    if (kernel === undefined) {
      // Outbox mode: the offer stays `stored` (in the outbox) until it is provably dead.
      if (dead) {
        journal.endOffer(slot, "expired");
        counts.expired += 1;
        actions.push("expired");
        log({ phase: "reconcile", tick, slot, offerId: short(current.offerId), result: "expired" });
      }
      return;
    }
    let status: KernelOfferStatus;
    try {
      status = await kernel.offerStatus(current.offerId);
    } catch (error) {
      actions.push("kernel-unreachable");
      log({ phase: "reconcile", tick, slot, offerId: short(current.offerId), result: "kernel_unreachable", detail: message(error) });
      return;
    }
    if (status === "expired") {
      journal.endOffer(slot, "expired");
      counts.expired += 1;
      actions.push("expired");
      return;
    }
    if (status === "consumed" || status === "cancelled") {
      // The coin is still in the wallet: its view lags the kernel's. Wait for the wallet.
      actions.push(`kernel-${status}-awaiting-wallet`);
      if (dead) {
        journal.endOffer(slot, "expired", { code: `KERNEL_${status.toUpperCase()}` });
        counts.expired += 1;
        actions.push("expired");
      }
      return;
    }
    if (status === "live") {
      if (record.state !== "live") {
        journal.markLive(slot);
        actions.push("live(kernel)");
      }
      return;
    }
    // not_found / unknown
    if (dead) {
      journal.endOffer(slot, "expired", { code: "NOT_FOUND_AFTER_EXPIRY" });
      counts.expired += 1;
      actions.push("expired");
      return;
    }
    // Audit C7: publish what is stored (covers the outbox → kernel switch), re-post a
    // `live` offer the kernel lost, and re-post a `submitted` one that was never indexed.
    // Always the SAME blob: the kernel answers DUPLICATE_OFFER if it already holds it.
    const waitedLongEnough =
      record.state !== "submitted" || current.postedAt === undefined || now - Date.parse(current.postedAt) >= cfg.submitConfirmMs;
    if (!waitedLongEnough) {
      actions.push("awaiting-index");
      return;
    }
    const entry = this.deps.outbox.get(current.offerId);
    if (entry === undefined) {
      actions.push("outbox-missing");
      log({ phase: "reconcile", tick, slot, offerId: short(current.offerId), result: "outbox_missing" });
      return; // the coin stays claimed until the offer is provably dead
    }
    if (this.#publishBlocked !== undefined) {
      actions.push("publish-blocked");
      return;
    }
    actions.push(record.state === "stored" ? "publish" : "re-post");
    await this.#post(slot, entry, tick, actions, counts);
  }

  async #offer(
    record: SlotRecord,
    snap: WalletSnapshot,
    tick: number,
    actions: string[],
    counts: { built: number; posted: number; rejected: number; errors: number; depleted: number; consumed: number; adopted: number },
  ): Promise<void> {
    const { cfg, journal, clock, log } = this.deps;
    const slot = record.slot;
    if (this.#publishBlocked !== undefined) {
      actions.push("publish-blocked");
      return;
    }
    if (this.deps.kernel !== undefined && !(this.#kernelLive instanceof Map)) {
      // Cannot prove the kernel holds no live offer for our coins: do not build (audit C1).
      actions.push("kernel-live-unknown");
      return;
    }
    const taken = new Set<string>([...journal.claimedNonces(slot), ...journal.assignedNonces(slot)]);
    // Audit C1: coins the kernel already holds a live offer for. One with exactly this
    // slot's legs is ADOPTED; any other is never built on until its offer is dead.
    const kernelHeld = new Map<string, KernelLiveOffer>();
    if (this.#kernelLive instanceof Map) {
      const adopted = new Set(journal.slots().flatMap((r) => (r.current ? [r.current.offerId] : [])));
      for (const c of snap.spendable) {
        const offer = this.#kernelLive.get(c.nullifier);
        if (offer !== undefined && !adopted.has(offer.offerId)) kernelHeld.set(c.nonce, offer);
      }
    }
    const adoptable = chooseCoin(record, { spendable: snap.spendable.filter((c) => {
      const offer = kernelHeld.get(c.nonce);
      return offer !== undefined && offerMatchesSlot(offer, record);
    }), owned: snap.owned }, cfg, taken);
    const coin = adoptable ?? chooseCoin(record, snap, cfg, new Set([...taken, ...kernelHeld.keys()]));
    if (coin === undefined) {
      if (chooseCoin(record, snap, cfg, taken) !== undefined) {
        actions.push("coins-held-by-kernel"); // wait until those offers are dead
        return;
      }
      journal.markDepleted(slot, `no ${cfg.coinPolicy === "exact" ? "exact" : "large enough"} ${short(record.giveColour)} coin of ${record.giveAmount}`);
      counts.depleted += 1;
      actions.push("depleted");
      log({ phase: "offer", tick, slot, result: "depleted" });
      return;
    }
    const held = adoptable !== undefined ? kernelHeld.get(coin.nonce) : undefined;
    if (held !== undefined) {
      const blob = await this.deps.kernel!.offerBlob(held.offerId).catch(() => undefined);
      const now = new Date(clock.now());
      const expiresAt = held.expiresAt ?? new Date(now.getTime() + cfg.rootWindowMs).toISOString();
      if (blob !== undefined) {
        this.deps.outbox.put({
          version: 1,
          offerId: held.offerId,
          blob,
          blobSha256: blobSha256(blob),
          networkId: cfg.networkId,
          slot,
          walletId: record.walletId,
          coinNonce: coin.nonce,
          coinNullifier: coin.nullifier,
          giveColour: record.giveColour,
          giveAmount: record.giveAmount,
          wantColour: record.wantColour,
          wantAmount: record.wantAmount,
          price: record.price,
          ttlSec: Math.round(cfg.offerTtlMs / 1000),
          builtAt: now.toISOString(),
          expiresAt,
        });
      }
      journal.adoptOffer(slot, {
        offerId: held.offerId,
        blobSha256: blob !== undefined ? blobSha256(blob) : "",
        delivery: "kernel",
        coinNonce: coin.nonce,
        coinNullifier: coin.nullifier,
        coinValue: coin.value.toString(),
        giveAmount: record.giveAmount,
        wantAmount: record.wantAmount,
        ttlSec: Math.round(cfg.offerTtlMs / 1000),
        builtAt: now.toISOString(),
        expiresAt,
      });
      counts.adopted += 1;
      actions.push("adopted");
      log({ phase: "offer", tick, slot, nonce: short(coin.nonce), offerId: short(held.offerId), result: "adopted" });
      return;
    }
    const wallet = await this.deps.wallets.get(record.walletId);
    const now = new Date(clock.now());
    const buildStarted = clock.now();
    let built: BuiltOffer;
    try {
      built = await withTimeout(
        wallet.build({
          giveColour: record.giveColour,
          giveAmount: BigInt(record.giveAmount),
          coin,
          wantColour: record.wantColour,
          wantAmount: BigInt(record.wantAmount),
          ttlMs: cfg.offerTtlMs,
          now,
        }),
        cfg.buildTimeoutMs,
        "offer build",
      );
    } catch (error) {
      const failures = record.consecutiveFailures + 1;
      const code =
        error instanceof Error && error.name === "WrongInputError"
          ? "WRONG_INPUT_NULLIFIER"
          : error instanceof Error && error.name === "TimeoutError"
            ? "BUILD_TIMEOUT"
            : "BUILD_FAILED";
      journal.markError(slot, code, redact(message(error)), new Date(clock.now() + retryDelayMs(cfg, failures)));
      counts.errors += 1;
      actions.push(`error:${code}`);
      log({ phase: "build", tick, slot, nonce: short(coin.nonce), result: "error", code, detail: redact(message(error)) });
      if (code === "BUILD_TIMEOUT") {
        // A hung proof cannot be cancelled and keeps the wallet's pin armed: exit so the
        // restart policy recovers (audit C6).
        this.stop();
        this.deps.onFatal?.(`offer build for ${slot} timed out after ${cfg.buildTimeoutMs} ms`);
      }
      return;
    }
    counts.built += 1;
    log({ phase: "build", tick, slot, nonce: short(coin.nonce), offerId: short(built.offerId), ms: clock.now() - buildStarted, chars: built.blob.length });
    const entry: OutboxEntry = {
      version: 1,
      offerId: built.offerId,
      blob: built.blob,
      blobSha256: built.blobSha256,
      networkId: cfg.networkId,
      slot,
      walletId: record.walletId,
      coinNonce: coin.nonce,
      coinNullifier: coin.nullifier,
      giveColour: record.giveColour,
      giveAmount: record.giveAmount,
      wantColour: record.wantColour,
      wantAmount: record.wantAmount,
      price: record.price,
      ttlSec: Math.round(cfg.offerTtlMs / 1000),
      builtAt: built.builtAt.toISOString(),
      expiresAt: built.expiresAt.toISOString(),
    };
    try {
      this.deps.outbox.put(entry);
      journal.beginOffer(slot, {
        offerId: built.offerId,
        blobSha256: built.blobSha256,
        delivery: this.deps.kernel ? "kernel" : "outbox",
        coinNonce: coin.nonce,
        coinNullifier: coin.nullifier,
        coinValue: coin.value.toString(),
        giveAmount: record.giveAmount,
        wantAmount: record.wantAmount,
        ttlSec: entry.ttlSec,
        builtAt: entry.builtAt,
        expiresAt: entry.expiresAt,
      });
    } catch (error) {
      // Audit C3: the claim is not durable → release the recipe, publish nothing more
      // this tick, and let the next tick retry once storage works again.
      await wallet.release(built.recipe).catch(() => undefined);
      this.#publishBlocked = message(error);
      counts.errors += 1;
      actions.push("persist-failed");
      log({ phase: "persist", tick, slot, offerId: short(built.offerId), result: "error", detail: redact(message(error)) });
      return;
    }
    actions.push("built");
    try {
      await wallet.release(built.recipe);
    } catch (error) {
      log({ phase: "release", tick, slot, result: "error", detail: redact(message(error)) });
    }
    if (this.deps.kernel === undefined) {
      counts.posted += 1;
      actions.push("stored(outbox)");
      log({ phase: "outbox", tick, slot, offerId: short(built.offerId), expiresAt: entry.expiresAt });
      return;
    }
    await this.#post(slot, entry, tick, actions, counts);
  }

  async #post(
    slot: string,
    entry: OutboxEntry,
    tick: number,
    actions: string[],
    counts: { posted: number; rejected: number; errors: number; consumed: number },
  ): Promise<void> {
    const { cfg, journal, clock, log, kernel } = this.deps;
    const outcome = await kernel!.postOffer(entry.blob);
    if (outcome.kind === "accepted") {
      if (outcome.offerId !== undefined && outcome.offerId !== entry.offerId) {
        // Audit C7/A13: the kernel hashes different bytes. Keep the coin CLAIMED (halt the
        // slot) instead of freeing it for a second offer.
        journal.halt(slot, "OFFER_ID_MISMATCH", `kernel offerId ${outcome.offerId} != local ${entry.offerId}`);
        counts.errors += 1;
        actions.push("halted:OFFER_ID_MISMATCH");
        return;
      }
      journal.markSubmitted(slot);
      counts.posted += 1;
      actions.push(outcome.duplicate ? "submitted(duplicate)" : "submitted");
      log({ phase: "post", tick, slot, offerId: short(entry.offerId), result: outcome.duplicate ? "duplicate" : "accepted", attempts: outcome.attempts });
      return;
    }
    if (outcome.kind === "rejected") {
      if (outcome.refusal === "SPENT") {
        journal.endOffer(slot, "consumed", { code: outcome.code });
        counts.consumed += 1;
        actions.push(`consumed(${outcome.code})`);
      } else {
        const failures = (journal.get(slot)?.consecutiveFailures ?? 0) + 1;
        journal.endOffer(slot, "rejected", {
          code: outcome.code,
          message: redact(`${outcome.status} ${outcome.refusal}: ${outcome.reason}`),
          retryAt: new Date(clock.now() + retryDelayMs(cfg, failures)),
        });
        counts.rejected += 1;
        actions.push(`rejected:${outcome.refusal}:${outcome.code}`);
      }
      log({ phase: "post", tick, slot, offerId: short(entry.offerId), result: "rejected", status: outcome.status, code: outcome.code, refusal: outcome.refusal });
      return;
    }
    // unavailable: keep the claim; the next tick re-posts the same blob.
    try {
      journal.notePostAttempt(slot, outcome.code);
    } catch (error) {
      if (!(error instanceof JournalError)) throw error;
    }
    actions.push("post-unavailable");
    log({ phase: "post", tick, slot, offerId: short(entry.offerId), result: "unavailable", detail: redact(outcome.error) });
  }

  /** Run ticks every `intervalMs` until `stop()`; a tick in progress finishes its current slot. */
  async loop(intervalMs: number, signal?: AbortSignal): Promise<void> {
    const { clock, log } = this.deps;
    signal?.addEventListener("abort", () => this.stop());
    while (!this.#stopping) {
      const started = clock.now();
      try {
        await this.runTick();
      } catch (error) {
        log({ phase: "tick", result: "exception", detail: message(error) });
      }
      if (this.#stopping) break;
      const wait = Math.max(0, intervalMs - (clock.now() - started));
      await clock.sleep(wait, signal);
    }
    log({ phase: "loop", result: "stopped" });
  }
}
