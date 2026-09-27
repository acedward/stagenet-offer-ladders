/**
 * Real `FunderOps` over the funding wallet's `WalletSession` (see `funding.ts` for the rules).
 *
 * One batch = one shielded transfer with N outputs, built with the wallet-sdk facade:
 * `transferTransaction` (fees from DUST) → `signRecipe` → `finalizeRecipe` (proof) → the
 * identifier is recorded → `submitTransaction` under a deadline, with the P12 indexer
 * fallback for a missed `Finalized` notice. The hash and block come from the indexer.
 *
 * The mnemonic is passed in memory (from the mode-600 funding file) and never printed.
 *
 * @module
 */
import type * as ledger from "@midnightntwrk/ledger-v9";
import { MidnightBech32m, ShieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

import type { FunderOps, PreparedTransfer, TransferOutput } from "./funding.ts";
import type { WalletNetwork } from "./network.ts";
import { type IndexedTx, lookupTransaction, submitWithIndexerFallback } from "./tx-lookup.ts";
import { WalletSession } from "./wallet-session.ts";

/** The note a result carries when only the indexer confirmed the transfer. */
export const MISSED_FINALIZED_NOTE = "the node's Finalized notice never arrived; the indexer shows the transaction with SUCCESS";

export interface OpenFunderOptions {
  readonly network: WalletNetwork;
  readonly dustParameters: ledger.DustParameters;
  readonly mnemonic: string;
  readonly log: (line: string) => void;
  /** Deadline for submission + finalization of one transfer [15 min]. */
  readonly submitTimeoutMs?: number;
  /** Deadline for the wallet to apply its own transfer before the next batch [10 min]. */
  readonly settleTimeoutMs?: number;
}

/** Look an identifier up until the indexer has it (it can lag the node by a few blocks). */
const indexed = async (network: WalletNetwork, identifier: string, attempts = 12, pauseMs = 5_000): Promise<IndexedTx | undefined> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const tx = await lookupTransaction(network.indexerHttpUrl, { identifier }).catch(() => undefined);
    if (tx !== undefined) return tx;
    if (attempt < attempts) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return undefined;
};

export const openFunderOps = async (options: OpenFunderOptions): Promise<FunderOps> => {
  const { network, log } = options;
  const session = await WalletSession.open({
    network,
    mnemonic: options.mnemonic,
    dustParameters: options.dustParameters,
    feeBlocksMargin: 5,
    syncTimeoutMs: 20 * 60 * 1000,
    log,
  });
  try {
    await session.synced();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  return {
    async balances() {
      const state = await session.caughtUp();
      const shielded: Record<string, bigint> = {};
      // Spendable coins only: a coin held by a pending spend cannot fund a transfer.
      for (const coin of WalletSession.spendableCoins(state)) shielded[coin.type] = (shielded[coin.type] ?? 0n) + coin.value;
      return { shielded, dust: WalletSession.balancesOf(state).dust };
    },
    async prepare(outputs: readonly TransferOutput[]): Promise<PreparedTransfer> {
      const ttl = new Date(Date.now() + 20 * 60_000);
      const recipe = await session.facade.transferTransaction(
        [
          {
            type: "shielded",
            outputs: outputs.map((o) => ({
              type: o.colour,
              amount: o.amount,
              receiverAddress: MidnightBech32m.parse(o.shieldedAddress).decode(ShieldedAddress, network.networkId),
            })),
          },
        ],
        session.secretKeys,
        { ttl },
      );
      const signed = await session.facade.signRecipe(recipe, (data) => session.signData(data));
      const finalized = await session.facade.finalizeRecipe(signed);
      const identifier = finalized.identifiers().at(-1);
      if (identifier === undefined) {
        await session.facade.revert(finalized).catch(() => undefined);
        throw new Error("the transfer has no identifier");
      }
      return {
        identifier,
        async submit() {
          const outcome = await submitWithIndexerFallback(() => session.facade.submitTransaction(finalized), {
            timeoutMs: options.submitTimeoutMs ?? 15 * 60_000,
            label: "maker funding transfer",
            identifier: () => identifier,
            lookup: (id) => lookupTransaction(network.indexerHttpUrl, { identifier: id }),
            log,
          });
          const tx = outcome.indexed ?? (await indexed(network, identifier));
          if (tx !== undefined && tx.status !== "SUCCESS") throw new Error(`transfer ${identifier.slice(0, 16)}… was included with status ${tx.status}`);
          return {
            txHash: tx?.hash,
            blockHeight: tx?.blockHeight,
            note: outcome.indexed !== undefined ? MISSED_FINALIZED_NOTE : tx === undefined ? "submitted and final; not found on the indexer yet" : undefined,
          };
        },
        async release() {
          await session.facade.revert(finalized);
        },
      };
    },
    async settle() {
      // The change of the last transfer must be spendable before the next batch selects coins.
      const deadline = Date.now() + (options.settleTimeoutMs ?? 10 * 60_000);
      for (;;) {
        const state = await session.caughtUp();
        if (state.shielded.pendingCoins.length === 0) return;
        if (Date.now() >= deadline) throw new Error("the funding wallet still holds pending coins after the settle deadline");
        await new Promise((r) => setTimeout(r, 3_000));
      }
    },
    async close() {
      await session.close();
    },
  };
};
