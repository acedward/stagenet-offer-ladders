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
 * @module
 */
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as ledger from "@midnightntwrk/ledger-v9";

import type { WalletNetwork } from "./network.ts";
import { collectNullifiers } from "./offer-builder.ts";
import { WalletSession } from "./wallet-session.ts";

export interface SettleArgs {
  readonly session: WalletSession;
  readonly network: WalletNetwork;
  readonly blob: string;
  /** Colour of the token the taker pays (the offer's want colour). */
  readonly payColour: string;
  /** Nonce of the taker's coin to pay with (pinned). */
  readonly payWithNonce: string;
  readonly ttlMs?: number;
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

export const settleOffer = async (args: SettleArgs): Promise<SettleResult> => {
  const { session, network, blob, log } = args;
  const raw = OfferFiles.decode(blob);
  const offerId = OfferFiles.offerId(raw);
  const offerTx = ledger.Transaction.deserialize("signature", "proof", "binding", raw) as ledger.FinalizedTransaction;
  const offerNullifiers = collectNullifiers(offerTx);
  log(`offer ${offerId.slice(0, 12)}… spends ${offerNullifiers.length} coin(s); balancing as taker (pay-with ${args.payWithNonce.slice(0, 12)}…)`);
  const ttl = new Date(Date.now() + (args.ttlMs ?? 20 * 60_000));
  const recipe = await session.pins.withPinnedCoin(args.payColour, args.payWithNonce, () =>
    session.facade.balanceFinalizedTransaction(offerTx, session.secretKeys, { ttl }),
  );
  const signed = await session.facade.signRecipe(recipe, (data) => session.signData(data));
  const finalized = await session.facade.finalizeRecipe(signed);
  const settlementNullifiers = collectNullifiers(finalized);
  const submittedAt = new Date().toISOString();
  const txId = await session.facade.submitTransaction(finalized);
  log(`submitted settlement ${String(txId).slice(0, 16)}…; waiting for the indexer`);
  setNetworkId(network.networkId);
  const indexer = indexerPublicDataProvider({ queryURL: network.indexerHttpUrl, subscriptionURL: network.indexerWsUrl });
  const data = await indexer.watchForTxData(txId as never);
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
