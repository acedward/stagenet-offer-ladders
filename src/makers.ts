import { Buffer } from "node:buffer";

import { redact } from "./redact.ts";

/**
 * Maker provisioning (plan P4): register each maker's NIGHT for DUST generation, then
 * self-mint its give token as ONE inventory coin.
 *
 * The decisions are pure and the loops take an injected `open(maker)` port, so the
 * idempotence and skip rules are unit-tested with fakes. Makers are processed ONE AT A
 * TIME (one wallet facade open at once), with an optional stagger.
 *
 * - `makers:register-dust` (reference: `registerNightForDust` in
 *   `@effectstream/midnight-contracts@0.200.6` `src/get-wallet-info.ts`, read from the npm
 *   tarball, not depended on): unregistered NIGHT UTxOs → `estimateRegistration` →
 *   `waitForGeneratedDust(fee)` → `registerNightUtxosForDustGeneration` → `finalizeRecipe`
 *   → `submitTransaction`. Skips a maker with no NIGHT and one whose NIGHT is all
 *   registered already.
 * - `makers:mint`: `mint(self, INVENTORY_OFFERS × give, nonce)` on the give token's
 *   contract (AB → stkA, BC → stkB), through 00052's providers. Skips a maker that
 *   already holds at least that amount of its give token, and one without enough DUST.
 *
 * @module
 */

export interface MakerRef {
  readonly slot: string;
  readonly ladder: string;
}

export interface MakerStatus {
  /** NIGHT UTxOs (value in STAR, whether registered for DUST generation). */
  readonly nightUtxos: readonly { value: bigint; registered: boolean }[];
  /** Spendable DUST now, in SPECK. */
  readonly dust: bigint;
  /** Spendable balance of the maker's give token, base units. */
  readonly giveBalance: bigint;
}

export interface MakerOps {
  status(): Promise<MakerStatus>;
  /** Register the unregistered NIGHT UTxOs; returns the submitted transaction id. */
  registerDust(): Promise<{ txId: string }>;
  /**
   * Mint `amount` base units of the give token to self as one coin, with the call nonce
   * `nonce` (64 hex). The minted coin's nonce equals the call nonce (00052 P4), which is
   * what makes a crashed mint reconcilable (audit C8).
   */
  mintGive(amount: bigint, nonce: string): Promise<{ txHash: string; blockHeight: number; status: string; coinNonce: string }>;
  /** Does the wallet own a coin with this nonce (spendable or pending)? */
  holdsCoin(nonce: string): Promise<boolean>;
  close(): Promise<void>;
}

export type RegisterDecision = "register" | "skip-no-night" | "skip-already-registered";
export type MintDecision = "mint" | "skip-already-holds" | "skip-already-minted" | "skip-no-dust";

export const registerDecision = (status: MakerStatus): RegisterDecision => {
  if (status.nightUtxos.length === 0 || status.nightUtxos.every((u) => u.value === 0n)) return "skip-no-night";
  if (status.nightUtxos.every((u) => u.registered)) return "skip-already-registered";
  return "register";
};

/**
 * `alreadyMinted`: a successful inventory mint is recorded for this maker (so a maker whose
 * offers were filled below the target is not topped up again by a re-run; the owner mints
 * once, spec US2).
 */
export const mintDecision = (status: MakerStatus, target: bigint, minDust: bigint, alreadyMinted = false): MintDecision => {
  if (alreadyMinted) return "skip-already-minted";
  if (status.giveBalance >= target) return "skip-already-holds";
  if (status.dust < minDust) return "skip-no-dust";
  return "mint";
};

export interface MakerResult {
  readonly slot: string;
  readonly action: string;
  readonly detail?: Record<string, unknown>;
  readonly error?: string;
}

const message = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

const forEachMaker = async (
  makers: readonly MakerRef[],
  open: (maker: MakerRef) => Promise<MakerOps>,
  step: (maker: MakerRef, ops: MakerOps) => Promise<MakerResult>,
  options: { staggerMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void },
): Promise<MakerResult[]> => {
  const results: MakerResult[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (const [index, maker] of makers.entries()) {
    if (index > 0 && (options.staggerMs ?? 0) > 0) await sleep(options.staggerMs!);
    let ops: MakerOps | undefined;
    try {
      ops = await open(maker);
      const result = await step(maker, ops);
      results.push(result);
      options.log?.(`${maker.slot}: ${result.action}`);
    } catch (error) {
      // One maker's failure never stops the others.
      results.push({ slot: maker.slot, action: "error", error: redact(message(error)) });
      options.log?.(`${maker.slot}: error ${redact(message(error))}`);
    } finally {
      await ops?.close().catch(() => undefined);
    }
  }
  return results;
};

export const registerDustAll = (
  makers: readonly MakerRef[],
  open: (maker: MakerRef) => Promise<MakerOps>,
  options: { staggerMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<MakerResult[]> =>
  forEachMaker(
    makers,
    open,
    async (maker, ops) => {
      const status = await ops.status();
      const decision = registerDecision(status);
      if (decision !== "register") return { slot: maker.slot, action: decision };
      const { txId } = await ops.registerDust();
      return {
        slot: maker.slot,
        action: "registered",
        detail: { txId, utxos: status.nightUtxos.filter((u) => !u.registered).length },
      };
    },
    options,
  );

/** A maker's inventory-mint record (public data), persisted BEFORE the mint is submitted. */
export interface MintRecord {
  readonly status: "pending" | "minted";
  /** Call nonce = minted coin nonce, 64 hex. */
  readonly nonce: string;
  readonly target: string;
  readonly token?: string;
  readonly at: string;
  readonly txHash?: string;
  readonly blockHeight?: number;
  readonly reconciled?: boolean;
  readonly migratedFrom?: string;
}

export const MINT_RECORDS_VERSION = 2 as const;

export class MintRecordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintRecordsError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * Load the maker mint records, migrating the pre-audit format (audit F-B17).
 *
 * - v2: `{ version: 2, records: { <slot>: MintRecord } }`.
 * - legacy (a bare slot map written before `47dce5a`): a successful receipt
 *   `{ status: "SucceedEntirely", coinNonce, amount, … }` becomes `minted` (nonce =
 *   coinNonce, target = amount). Any other legacy status is refused.
 *
 * Every record is validated; anything unrecognised is REFUSED (fail closed) rather than
 * treated as "never minted". `migrated` tells the caller to persist before minting.
 */
export const loadMintRecords = (raw: unknown): { records: Record<string, MintRecord>; migrated: boolean } => {
  if (raw === undefined || raw === null) return { records: {}, migrated: false };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new MintRecordsError("maker-mints.json is not an object");
  const obj = raw as Record<string, unknown>;
  const v2 = obj["version"] === MINT_RECORDS_VERSION;
  const source = (v2 ? obj["records"] : obj) as Record<string, unknown> | undefined;
  if (typeof source !== "object" || source === null || Array.isArray(source)) throw new MintRecordsError("maker-mints.json has no records");
  const records: Record<string, MintRecord> = {};
  let migrated = !v2;
  for (const [slot, value] of Object.entries(source)) {
    if (slot === "version") continue;
    const r = value as Record<string, unknown>;
    if (typeof r !== "object" || r === null) throw new MintRecordsError(`${slot}: not a record`);
    if (r["status"] === "minted" || r["status"] === "pending") {
      if (typeof r["nonce"] !== "string" || !HEX64.test(r["nonce"])) throw new MintRecordsError(`${slot}: bad nonce`);
      if (typeof r["target"] !== "string" || !/^[0-9]+$/u.test(r["target"])) throw new MintRecordsError(`${slot}: bad target`);
      records[slot] = r as unknown as MintRecord;
      continue;
    }
    if (r["status"] === "SucceedEntirely") {
      const nonce = String(r["coinNonce"] ?? "").toLowerCase();
      const amount = String(r["amount"] ?? "");
      if (!HEX64.test(nonce) || !/^[0-9]+$/u.test(amount)) throw new MintRecordsError(`${slot}: legacy receipt without coinNonce/amount`);
      records[slot] = {
        status: "minted",
        nonce,
        target: amount,
        at: String(r["at"] ?? ""),
        ...(typeof r["token"] === "string" ? { token: r["token"] } : {}),
        ...(typeof r["txHash"] === "string" ? { txHash: r["txHash"] } : {}),
        ...(typeof r["blockHeight"] === "number" ? { blockHeight: r["blockHeight"] } : {}),
        migratedFrom: "SucceedEntirely",
      } as MintRecord;
      migrated = true;
      continue;
    }
    throw new MintRecordsError(`${slot}: unknown mint record status ${JSON.stringify(r["status"])}; refusing to guess`);
  }
  return { records, migrated };
};

export const serializeMintRecords = (records: Readonly<Record<string, MintRecord>>): string =>
  `${JSON.stringify({ version: MINT_RECORDS_VERSION, records }, null, 2)}\n`;

export const mintAll = (
  makers: readonly MakerRef[],
  open: (maker: MakerRef) => Promise<MakerOps>,
  target: bigint,
  minDust: bigint,
  options: {
    staggerMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    /** Current records by slot (pending or minted). */
    records?: Readonly<Record<string, MintRecord>>;
    /** Persist a record durably; called with `pending` BEFORE submitting (audit C8). */
    onRecord?: (slot: string, record: MintRecord) => void;
    /** Fresh call nonce (64 hex). */
    newNonce?: () => string;
    now?: () => Date;
  } = {},
): Promise<MakerResult[]> => {
  const now = options.now ?? (() => new Date());
  const newNonce =
    options.newNonce ??
    (() => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Buffer.from(bytes).toString("hex");
    });
  return forEachMaker(
    makers,
    open,
    async (maker, ops) => {
      const record = options.records?.[maker.slot];
      if (record?.status === "minted") return { slot: maker.slot, action: "skip-already-minted" };
      if (record?.status === "pending") {
        // A mint was submitted but its outcome was never recorded: reconcile by coin nonce,
        // and NEVER mint again while it is unresolved.
        if (await ops.holdsCoin(record.nonce)) {
          options.onRecord?.(maker.slot, { ...record, status: "minted", reconciled: true, at: now().toISOString() });
          return { slot: maker.slot, action: "reconciled-minted", detail: { nonce: record.nonce } };
        }
        return { slot: maker.slot, action: "skip-pending-unresolved", detail: { nonce: record.nonce, since: record.at } };
      }
      const status = await ops.status();
      const decision = mintDecision(status, target, minDust);
      if (decision !== "mint") return { slot: maker.slot, action: decision, detail: { giveBalance: status.giveBalance, dust: status.dust } };
      const nonce = newNonce();
      const pending: MintRecord = { status: "pending", nonce, target: target.toString(), at: now().toISOString() };
      options.onRecord?.(maker.slot, pending);
      const minted = await ops.mintGive(target, nonce);
      const detail = { ...minted, amount: target };
      if (minted.status === "SucceedEntirely") {
        options.onRecord?.(maker.slot, { ...pending, status: "minted", txHash: minted.txHash, blockHeight: minted.blockHeight, at: now().toISOString() });
      }
      return { slot: maker.slot, action: minted.status === "SucceedEntirely" ? "minted" : "mint-failed", detail };
    },
    options,
  );
};
