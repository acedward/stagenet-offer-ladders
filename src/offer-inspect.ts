/**
 * Decode a `swapoffer1…` string and report what it gives, wants and spends (public data).
 * Used to verify built offers (plan P3: imbalances equal the grid, one input, TTL).
 *
 * @module
 */
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { P2pAtomicSwaps } from "@effectstream/mip-zswap-offer/mip6";
import type { UnprovenTransaction } from "@midnightntwrk/ledger-v9";

import { collectNullifiers, countFallibleInputs } from "./offer-builder.ts";

export interface OfferInspection {
  readonly offerId: string;
  readonly bytes: number;
  readonly gives: readonly { token: string; amount: string; type: string }[];
  readonly wants: readonly { token: string; amount: string; type: string }[];
  readonly inputNullifiers: readonly string[];
  readonly fallibleInputs: number;
  /** Earliest intent TTL (ISO), if the offer carries one. */
  readonly ttl: string | undefined;
}

export const inspectOffer = (blob: string): OfferInspection => {
  const raw = OfferFiles.decode(blob);
  const tx = OfferFiles.fromBech32(blob) as unknown as UnprovenTransaction;
  const { gives, wants } = P2pAtomicSwaps.deriveTokenLegs(tx);
  return {
    offerId: OfferFiles.offerId(raw),
    bytes: raw.length,
    gives: gives.map((leg) => ({ token: leg.token, amount: leg.amount, type: leg.type })),
    wants: wants.map((leg) => ({ token: leg.token, amount: leg.amount, type: leg.type })),
    inputNullifiers: collectNullifiers(tx),
    fallibleInputs: countFallibleInputs(tx),
    ttl: P2pAtomicSwaps.earliestIntentTtl(tx),
  };
};
