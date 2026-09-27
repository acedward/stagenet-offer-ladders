import { redact } from "./redact.ts";
import type { LadderFile } from "./ladder.ts";
import { toBaseUnits } from "./ladder.ts";
import type { IndexedTx } from "./tx-lookup.ts";

/**
 * Maker funding (00057 FR-003, spec US2): move each book maker's give inventory from the
 * funding wallet to the maker by shielded transfer (`makers:fund`).
 *
 * - **Plan**: every slot of a ladder with `inventoryTokens` gets that many whole give tokens,
 *   sent to its maker wallet's shielded address from the PUBLIC makers file. No maker secret
 *   is read for this.
 * - **Idempotent** (questions-file Q7): a durable record per maker and colour in
 *   `$STATE_DIR/maker-funding.json`. `pending` (with the transaction identifier) is written
 *   BEFORE the transfer is submitted and `sent` (hash, block) after, so a crash can never
 *   lead to a second payment: a `pending` record is resolved on the indexer (`SUCCESS` →
 *   `sent`) and otherwise left for the operator, never re-sent blindly (as `makers:mint`,
 *   audit C8). With `--check-balances`, a maker that already holds its inventory is also
 *   skipped (that reads the maker's wallet, so the service must not be running).
 * - **Batched**: one transfer per `batchSize` makers of the same colour (one transaction
 *   with N shielded outputs), one batch at a time; the funder's change must be spendable
 *   again before the next batch. The first failed batch stops the run.
 * - Before anything is sent, the funder must hold every colour's total: a short wallet is
 *   refused whole, not funded halfway.
 *
 * The decisions and the loop take injected ports, so they are unit-tested with fakes; the
 * real ports are in `funding-ops.ts` and `cli.ts`.
 *
 * @module
 */

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingError";
  }
}

/** One maker to fund: public data only. */
export interface FundingTarget {
  readonly slot: string;
  readonly walletId: string;
  readonly symbol: string;
  readonly colour: string;
  /** Base units of the give colour. */
  readonly amount: bigint;
  readonly shieldedAddress: string;
}

/** What `planFunding` needs of a slot (structurally the service's `SlotPlan`). */
export interface FundingSlot {
  readonly slot: string;
  readonly ladder: string;
  readonly walletId: string;
  readonly giveColour: string;
}

/**
 * Who receives what: every slot whose ladder names `inventoryTokens`, in slot order.
 * `addressOf(walletId)` returns the maker's shielded address from the public file.
 */
export const planFunding = (
  slots: readonly FundingSlot[],
  file: LadderFile,
  addressOf: (walletId: string) => string | undefined,
): FundingTarget[] => {
  const targets: FundingTarget[] = [];
  for (const slot of slots) {
    const ladder = file.ladders.find((l) => l.id === slot.ladder);
    if (ladder?.inventoryTokens === undefined) continue;
    const token = file.tokens[ladder.give]!;
    const shieldedAddress = addressOf(slot.walletId);
    if (shieldedAddress === undefined) throw new FundingError(`no public shielded address for wallet ${slot.walletId} (slot ${slot.slot})`);
    targets.push({
      slot: slot.slot,
      walletId: slot.walletId,
      symbol: ladder.give,
      colour: slot.giveColour,
      amount: toBaseUnits(ladder.inventoryTokens, token.decimals),
      shieldedAddress,
    });
  }
  return targets;
};

// ---------------------------------------------------------------------------
// Records ($STATE_DIR/maker-funding.json, public data)
// ---------------------------------------------------------------------------

export const FUNDING_RECORDS_VERSION = 1 as const;

export interface TransferRecord {
  readonly status: "pending" | "sent";
  readonly walletId: string;
  readonly slot: string;
  readonly symbol: string;
  readonly colour: string;
  /** Base units, decimal string. */
  readonly amount: string;
  /** The transfer transaction's identifier (what the indexer is asked about). */
  readonly txId: string;
  /** `k/n` of the run that sent it. */
  readonly batch: string;
  readonly at: string;
  readonly txHash?: string;
  readonly blockHeight?: number;
  /** Set when a `pending` record was confirmed later on the indexer. */
  readonly reconciled?: boolean;
  readonly note?: string;
}

export const fundingKey = (target: Pick<FundingTarget, "walletId" | "colour">): string => `${target.walletId}/${target.colour}`;

const HEX64 = /^[0-9a-f]{64}$/u;

/** Load the records; a present but malformed document is refused (fail closed, as mint records). */
export const loadFundingRecords = (raw: unknown, present: boolean, networkId: string): Record<string, TransferRecord> => {
  if (!present) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new FundingError("maker-funding.json is present but not an object");
  const doc = raw as Record<string, unknown>;
  if (doc["version"] !== FUNDING_RECORDS_VERSION) throw new FundingError(`maker-funding.json has unsupported version ${JSON.stringify(doc["version"])}`);
  if (doc["networkId"] !== networkId) throw new FundingError(`maker-funding.json is for ${String(doc["networkId"])}, not ${networkId}`);
  const transfers = doc["transfers"];
  if (typeof transfers !== "object" || transfers === null || Array.isArray(transfers)) throw new FundingError("maker-funding.json has no transfers");
  const out: Record<string, TransferRecord> = {};
  for (const [key, value] of Object.entries(transfers)) {
    const r = value as Record<string, unknown>;
    const ok =
      typeof r === "object" && r !== null &&
      (r["status"] === "pending" || r["status"] === "sent") &&
      typeof r["walletId"] === "string" &&
      typeof r["colour"] === "string" && HEX64.test(r["colour"]) &&
      typeof r["amount"] === "string" && /^[0-9]+$/u.test(r["amount"]) &&
      typeof r["txId"] === "string" && /^[0-9a-f]{64,}$/u.test(r["txId"]) &&
      key === `${r["walletId"]}/${r["colour"]}`;
    if (!ok) throw new FundingError(`maker-funding.json: record ${key} is malformed; refusing to guess`);
    out[key] = r as unknown as TransferRecord;
  }
  return out;
};

export const serializeFundingRecords = (records: Readonly<Record<string, TransferRecord>>, networkId: string): string =>
  `${JSON.stringify({ version: FUNDING_RECORDS_VERSION, networkId, transfers: records }, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TransferOutput {
  readonly colour: string;
  readonly amount: bigint;
  readonly shieldedAddress: string;
}

/** A proven, signed transfer that has not been submitted yet. */
export interface PreparedTransfer {
  readonly identifier: string;
  submit(): Promise<{ txHash?: string | undefined; blockHeight?: number | undefined; note?: string | undefined }>;
  /** Release the wallet's local hold on the inputs of a transfer that is not submitted. */
  release(): Promise<void>;
}

export interface FunderOps {
  /** Spendable shielded balance per colour, and DUST (SPECK). */
  balances(): Promise<{ shielded: Readonly<Record<string, bigint>>; dust: bigint }>;
  prepare(outputs: readonly TransferOutput[]): Promise<PreparedTransfer>;
  /** Wait until the wallet has applied its own transfers (the change is spendable again). */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface FundingPorts {
  /** Indexer lookup of a transaction identifier (resolves `pending` records). */
  lookup(identifier: string): Promise<IndexedTx | undefined>;
  /** `--check-balances` only: a maker's spendable balance of a colour. */
  makerBalance?: ((walletId: string, colour: string) => Promise<bigint>) | undefined;
  openFunder(): Promise<FunderOps>;
}

export interface FundingOptions {
  readonly batchSize: number;
  readonly dryRun: boolean;
  readonly records: Readonly<Record<string, TransferRecord>>;
  /** Persist a record durably (called with `pending` BEFORE a submit). */
  readonly onRecord: (key: string, record: TransferRecord) => void;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export type FundingAction =
  | "send"
  | "sent"
  | "skip-already-sent"
  | "skip-already-holds"
  | "skip-pending-unresolved"
  | "not-sent"
  | "error";

export interface FundingResult {
  readonly slot: string;
  readonly walletId: string;
  readonly symbol: string;
  readonly amount: string;
  readonly action: FundingAction;
  readonly batch?: string;
  readonly txId?: string;
  readonly txHash?: string;
  readonly blockHeight?: number;
  readonly detail?: string;
}

export interface FundingReport {
  readonly dryRun: boolean;
  readonly results: readonly FundingResult[];
  /** Per symbol: base units this run sends (dry run: would send). */
  readonly totals: Readonly<Record<string, string>>;
  readonly batches: number;
  /** The funding wallet's spendable balances per colour and DUST, read before anything was sent. */
  readonly funderBefore?: { readonly shielded: Readonly<Record<string, string>>; readonly dust: string };
}

const message = (error: unknown): string => redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Consecutive chunks of `size`, per colour, colours in order of first appearance. */
export const batchesOf = <T extends { colour: string }>(items: readonly T[], size: number): T[][] => {
  if (!Number.isSafeInteger(size) || size < 1) throw new FundingError("batch size must be a positive integer");
  const byColour = new Map<string, T[]>();
  for (const item of items) byColour.set(item.colour, [...(byColour.get(item.colour) ?? []), item]);
  const out: T[][] = [];
  for (const group of byColour.values()) for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size));
  return out;
};

export const fundMakers = async (targets: readonly FundingTarget[], ports: FundingPorts, options: FundingOptions): Promise<FundingReport> => {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const results = new Map<string, FundingResult>();
  const base = (t: FundingTarget) => ({ slot: t.slot, walletId: t.walletId, symbol: t.symbol, amount: t.amount.toString() });
  const toSend: FundingTarget[] = [];

  // 1. Decide per maker, from the records (and the maker's balance with --check-balances).
  for (const target of targets) {
    const key = fundingKey(target);
    const record = options.records[key];
    if (record?.status === "sent") {
      results.set(key, { ...base(target), action: "skip-already-sent", txId: record.txId, ...(record.txHash ? { txHash: record.txHash } : {}) });
      continue;
    }
    if (record?.status === "pending") {
      let tx: IndexedTx | undefined;
      let lookupError: string | undefined;
      try {
        tx = await ports.lookup(record.txId);
      } catch (error) {
        lookupError = message(error);
      }
      if (tx?.status === "SUCCESS") {
        const sent: TransferRecord = { ...record, status: "sent", txHash: tx.hash, blockHeight: tx.blockHeight, reconciled: true, at: now().toISOString() };
        if (!options.dryRun) options.onRecord(key, sent);
        results.set(key, { ...base(target), action: "skip-already-sent", txId: record.txId, txHash: tx.hash, blockHeight: tx.blockHeight, detail: "pending record confirmed on the indexer" });
      } else {
        // Never pay twice: an unresolved transfer blocks this maker until an operator decides.
        const detail = lookupError ?? (tx === undefined ? "not indexed" : `indexed with status ${tx.status}`);
        results.set(key, { ...base(target), action: "skip-pending-unresolved", txId: record.txId, detail });
      }
      continue;
    }
    if (ports.makerBalance !== undefined) {
      const held = await ports.makerBalance(target.walletId, target.colour);
      if (held >= target.amount) {
        results.set(key, { ...base(target), action: "skip-already-holds", detail: `holds ${held}` });
        continue;
      }
    }
    results.set(key, { ...base(target), action: "send" });
    toSend.push(target);
  }

  const totals: Record<string, bigint> = {};
  for (const target of toSend) totals[target.symbol] = (totals[target.symbol] ?? 0n) + target.amount;
  const batches = batchesOf(toSend, options.batchSize);
  const report = (funder?: FundingReport["funderBefore"]): FundingReport => ({
    dryRun: options.dryRun,
    results: targets.map((t) => results.get(fundingKey(t))!),
    totals: Object.fromEntries(Object.entries(totals).map(([s, v]) => [s, v.toString()])),
    batches: batches.length,
    ...(funder === undefined ? {} : { funderBefore: funder }),
  });
  if (options.dryRun || toSend.length === 0) return report();

  // 2. Send, batch by batch, from the funding wallet.
  const funder = await ports.openFunder();
  let funderView: FundingReport["funderBefore"];
  try {
    const held = await funder.balances();
    funderView = { shielded: Object.fromEntries(Object.entries(held.shielded).map(([c, v]) => [c, v.toString()])), dust: held.dust.toString() };
    const need = new Map<string, bigint>();
    for (const target of toSend) need.set(target.colour, (need.get(target.colour) ?? 0n) + target.amount);
    for (const [colour, amount] of need) {
      const have = held.shielded[colour] ?? 0n;
      if (have < amount) throw new FundingError(`the funding wallet holds ${have} of ${colour.slice(0, 12)}…, the plan needs ${amount}; nothing was sent`);
    }
    if (held.dust <= 0n) throw new FundingError("the funding wallet has no DUST for the fees; nothing was sent");
    for (const [index, batch] of batches.entries()) {
      const label = `${index + 1}/${batches.length}`;
      let prepared: PreparedTransfer;
      try {
        prepared = await funder.prepare(batch.map((t) => ({ colour: t.colour, amount: t.amount, shieldedAddress: t.shieldedAddress })));
      } catch (error) {
        for (const t of batch) results.set(fundingKey(t), { ...base(t), action: "error", batch: label, detail: `prepare: ${message(error)}` });
        break;
      }
      const at = now().toISOString();
      try {
        // Durable BEFORE the transfer can leave the process.
        for (const t of batch) {
          options.onRecord(fundingKey(t), { status: "pending", walletId: t.walletId, slot: t.slot, symbol: t.symbol, colour: t.colour, amount: t.amount.toString(), txId: prepared.identifier, batch: label, at });
        }
      } catch (error) {
        await prepared.release().catch(() => undefined);
        for (const t of batch) results.set(fundingKey(t), { ...base(t), action: "error", batch: label, detail: `record: ${message(error)}` });
        break;
      }
      log(`batch ${label}: ${batch.length} × ${batch[0]!.symbol} → ${batch.map((t) => t.walletId).join(", ")} (tx ${prepared.identifier.slice(0, 16)}…)`);
      let outcome: Awaited<ReturnType<PreparedTransfer["submit"]>>;
      try {
        outcome = await prepared.submit();
      } catch (error) {
        // Outcome unknown: the pending records stay; a re-run resolves them on the indexer.
        for (const t of batch) results.set(fundingKey(t), { ...base(t), action: "error", batch: label, txId: prepared.identifier, detail: `submit: ${message(error)}` });
        break;
      }
      for (const t of batch) {
        const sent: TransferRecord = {
          status: "sent",
          walletId: t.walletId,
          slot: t.slot,
          symbol: t.symbol,
          colour: t.colour,
          amount: t.amount.toString(),
          txId: prepared.identifier,
          batch: label,
          at: now().toISOString(),
          ...(outcome.txHash === undefined ? {} : { txHash: outcome.txHash }),
          ...(outcome.blockHeight === undefined ? {} : { blockHeight: outcome.blockHeight }),
          ...(outcome.note === undefined ? {} : { note: outcome.note }),
        };
        options.onRecord(fundingKey(t), sent);
        results.set(fundingKey(t), {
          ...base(t),
          action: "sent",
          batch: label,
          txId: prepared.identifier,
          ...(outcome.txHash === undefined ? {} : { txHash: outcome.txHash }),
          ...(outcome.blockHeight === undefined ? {} : { blockHeight: outcome.blockHeight }),
        });
      }
      if (index < batches.length - 1) await funder.settle();
    }
  } finally {
    await funder.close().catch(() => undefined);
  }
  // Makers of batches that never ran stay "send" in the decisions: report them as not sent.
  for (const [key, result] of results) if (result.action === "send") results.set(key, { ...result, action: "not-sent", detail: "an earlier batch failed" });
  return report(funderView);
};
