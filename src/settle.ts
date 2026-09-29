/**
 * Test taker: settle one stored Offer File on chain.
 *
 * The offer is deserialized, balanced by a taker wallet (the taker pays the offer's want
 * token and receives its give token; DUST pays the fee), finalized and submitted, then
 * watched on the indexer until it is final. Same recipe as `zswap-offerfiles-kernel`
 * @ 67db767 `api-examples/11-settle-offer.ts` (`balanceFinalizedTransaction` →
 * `finalizeRecipe` → `submitTransaction`), with one addition: the taker's input of the
 * want colour is PINNED to a named coin (`--pay-with`), because the default selector is
 * smallest-first and in the single-wallet test would spend a coin that another live offer
 * is pinned to.
 *
 * `dryRun` (00058 FR-007): balance, sign and finalize exactly as above, report the fee and the
 * transaction's size, release what the wallet reserved (`facade.revert`), and stop BEFORE
 * `submitTransaction`. Nothing leaves the process and no coin moves.
 *
 * @module
 */
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as ledger from "@midnightntwrk/ledger-v9";

import { formatUnits } from "./book.ts";
import type { WalletNetwork } from "./network.ts";
import { collectNullifiers } from "./offer-builder.ts";
import type { PinController } from "./pinned-wallet.ts";
import { withTimeout } from "./scheduler.ts";

/** 1 DUST = 10^15 SPECK (the unit `Transaction.fees` returns). */
export const SPECK_DECIMALS = 15;

/** The settlement transaction as far as settling needs it (a ledger `FinalizedTransaction`). */
export interface SettlementTx {
  identifiers(): readonly string[];
  serialize(): Uint8Array;
  fees(params: ledger.LedgerParameters, enforceTimeToDismiss?: boolean): bigint;
}

/**
 * The wallet surface settling needs; `WalletSession` implements it (tests use fakes). The
 * facade calls are the SDK's; their argument types are left open here on purpose.
 */
export interface SettleSession {
  readonly pins: Pick<PinController, "withPinnedCoin">;
  readonly secretKeys: unknown;
  signData(data: Uint8Array): Promise<unknown>;
  readonly facade: {
    balanceFinalizedTransaction(tx: never, secretKeys: never, options: { ttl: Date }): Promise<unknown>;
    signRecipe(recipe: never, sign: (data: Uint8Array) => Promise<never>): Promise<unknown>;
    finalizeRecipe(recipe: never): Promise<SettlementTx>;
    submitTransaction(tx: never): Promise<unknown>;
    revert(tx: never): Promise<unknown>;
  };
}

export interface SettleArgs {
  readonly session: SettleSession;
  readonly network: WalletNetwork;
  readonly blob: string;
  /** Colour of the token the taker pays (the offer's want colour). */
  readonly payColour: string;
  /** Nonce of the taker's coin to pay with (pinned). */
  readonly payWithNonce: string;
  readonly ttlMs?: number;
  /** Deadline for the indexer to report the settlement final (audit C6; default 10 min). */
  readonly inclusionTimeoutMs?: number;
  readonly log: (line: string) => void;
}

export interface SettleResult {
  readonly offerId: string;
  readonly offerNullifiers: readonly string[];
  readonly settlementNullifiers: readonly string[];
  readonly txId: string;
  readonly txHash: string;
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly status: string;
  readonly submittedAt: string;
  readonly finalAt: string;
}

export interface DryRunArgs extends Omit<SettleArgs, "network" | "inclusionTimeoutMs"> {
  /** Ledger parameters for the fee estimate (the CLI reads them from the indexer). */
  readonly feeParameters?: ledger.LedgerParameters | undefined;
}

/** What a dry run built. Nothing was submitted. */
export interface DryRunResult {
  readonly dryRun: true;
  readonly submitted: false;
  readonly offerId: string;
  readonly offerNullifiers: readonly string[];
  readonly settlementNullifiers: readonly string[];
  /** The finalized settlement's identifier (what the indexer would be asked about). */
  readonly txId: string | null;
  /** Serialized size of the finalized settlement. */
  readonly bytes: number;
  /** `Transaction.fees(ledger parameters)`, SPECK and DUST; null without parameters. */
  readonly feeSpecks: string | null;
  readonly feeDust: string | null;
  readonly feeError?: string;
  /** Whether the wallet's reservation was released (`facade.revert`). */
  readonly released: boolean;
  readonly balanceMs: number;
  readonly finalizeMs: number;
}

/** Decode an Offer File blob into its id and ledger transaction. */
export const decodeOffer = (blob: string): { offerId: string; offerTx: ledger.FinalizedTransaction } => {
  const raw = OfferFiles.decode(blob);
  const offerId = OfferFiles.offerId(raw);
  const offerTx = ledger.Transaction.deserialize("signature", "proof", "binding", raw) as ledger.FinalizedTransaction;
  return { offerId, offerTx };
};

/** Balance (pinned pay coin) → sign → finalize: the shared part of a settle and a dry run. */
const balanceAndFinalize = async (
  session: SettleSession,
  offerTx: unknown,
  args: { payColour: string; payWithNonce: string; ttlMs?: number | undefined },
): Promise<{ finalized: SettlementTx; balanceMs: number; finalizeMs: number }> => {
  const ttl = new Date(Date.now() + (args.ttlMs ?? 20 * 60_000));
  const started = Date.now();
  const recipe = await session.pins.withPinnedCoin(args.payColour, args.payWithNonce, () =>
    session.facade.balanceFinalizedTransaction(offerTx as never, session.secretKeys as never, { ttl }),
  );
  const balanced = Date.now();
  const signed = await session.facade.signRecipe(recipe as never, (data) => session.signData(data) as Promise<never>);
  const finalized = await session.facade.finalizeRecipe(signed as never);
  return { finalized, balanceMs: balanced - started, finalizeMs: Date.now() - balanced };
};

/**
 * Dry run on an already decoded offer (unit-tested with a fake session): balance and
 * finalize, measure, release, and never call `submitTransaction`.
 */
export const dryRunDecoded = async (
  args: Omit<DryRunArgs, "blob"> & { offerId: string; offerTx: unknown },
): Promise<DryRunResult> => {
  const { session, log } = args;
  const offerNullifiers = collectNullifiers(args.offerTx);
  log(`DRY RUN: offer ${args.offerId.slice(0, 12)}… spends ${offerNullifiers.length} coin(s); balancing as taker (pay-with ${args.payWithNonce.slice(0, 12)}…); nothing will be submitted`);
  const { finalized, balanceMs, finalizeMs } = await balanceAndFinalize(session, args.offerTx, args);
  const settlementNullifiers = collectNullifiers(finalized);
  const bytes = finalized.serialize().length;
  const txId = finalized.identifiers().at(-1) ?? null;
  let feeSpecks: bigint | null = null;
  let feeError: string | undefined;
  if (args.feeParameters !== undefined) {
    try {
      feeSpecks = finalized.fees(args.feeParameters);
    } catch (error) {
      feeError = error instanceof Error ? error.message : String(error);
    }
  }
  let released = false;
  try {
    await session.facade.revert(finalized as never);
    released = true;
  } catch (error) {
    log(`DRY RUN: releasing the wallet's reservation failed (${error instanceof Error ? error.message : String(error)}); the session is closed next, so nothing is kept`);
  }
  log(`DRY RUN: balanced in ${balanceMs} ms, finalized in ${finalizeMs} ms, ${bytes} bytes, fee ${feeSpecks === null ? "n/a" : `${formatUnits(feeSpecks, SPECK_DECIMALS)} DUST`}; NOT submitted`);
  return {
    dryRun: true,
    submitted: false,
    offerId: args.offerId,
    offerNullifiers,
    settlementNullifiers,
    txId,
    bytes,
    feeSpecks: feeSpecks === null ? null : feeSpecks.toString(),
    feeDust: feeSpecks === null ? null : formatUnits(feeSpecks, SPECK_DECIMALS),
    ...(feeError === undefined ? {} : { feeError }),
    released,
    balanceMs,
    finalizeMs,
  };
};

/** `offers:settle --dry-run`: decode the stored blob, then `dryRunDecoded`. */
export const dryRunSettlement = async (args: DryRunArgs): Promise<DryRunResult> => {
  const { offerId, offerTx } = decodeOffer(args.blob);
  return await dryRunDecoded({ ...args, offerId, offerTx });
};

export const settleOffer = async (args: SettleArgs): Promise<SettleResult> => {
  const { session, network, blob, log } = args;
  const { offerId, offerTx } = decodeOffer(blob);
  const offerNullifiers = collectNullifiers(offerTx);
  log(`offer ${offerId.slice(0, 12)}… spends ${offerNullifiers.length} coin(s); balancing as taker (pay-with ${args.payWithNonce.slice(0, 12)}…)`);
  const { finalized } = await balanceAndFinalize(session, offerTx, args);
  const settlementNullifiers = collectNullifiers(finalized);
  const submittedAt = new Date().toISOString();
  // The SDK's submitTransaction already waits for finalisation: bound it too (audit C6).
  const txId = await withTimeout(session.facade.submitTransaction(finalized as never), args.inclusionTimeoutMs ?? 10 * 60_000, "settlement submission");
  log(`submitted settlement ${String(txId).slice(0, 16)}…; waiting for the indexer`);
  setNetworkId(network.networkId);
  const indexer = indexerPublicDataProvider({ queryURL: network.indexerHttpUrl, subscriptionURL: network.indexerWsUrl });
  const data = await withTimeout(indexer.watchForTxData(txId as never), args.inclusionTimeoutMs ?? 10 * 60_000, "settlement inclusion");
  return {
    offerId,
    offerNullifiers,
    settlementNullifiers,
    txId: String(data.txId ?? txId),
    txHash: String(data.txHash),
    blockHeight: data.blockHeight,
    blockHash: String(data.blockHash),
    status: String(data.status),
    submittedAt,
    finalAt: new Date().toISOString(),
  };
};
