/**
 * Build ONE maker Offer File that spends exactly one named coin.
 *
 * Vendored from `effectstream/zswap-offerfiles-kernel` @ 67db767ed7b7c8f9167bad7197ff01ffb58fd39e
 * (Apache-2.0):
 * - `deploy/scripts/lib/maker-offer.ts` — `initSwap({give}, [{want → own address}],
 *   { ttl, payFees: false })` → `finalizeTransaction` → `OfferFiles.encode`. The want leg
 *   is routed to the maker's shielded address OBJECT (not a string), which is what makes
 *   the transaction unbalanced: it gives `give` and needs `want`.
 * - `deploy/scripts/offer-poster.ts` `makeBuilder` / `countFallibleInputs` and the
 *   exact-coin assertion of `lib/poster-tick.ts` `offerCoin`: the finalized offer must
 *   list exactly `[coin.nullifier]` and nothing in a fallible segment, else the recipe is
 *   reverted and nothing is stored or posted.
 * - `packages/validator/derive.ts` `collectNullifiers` / `bytesOrStringToHex`.
 *
 * Adapted: the wallet is a narrow port (`OfferWallet`) so the build and the assertion are
 * unit-testable with fakes; the pin controller is per wallet (see `pinned-wallet.ts`).
 *
 * @module
 */
import { Buffer } from "node:buffer";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import { blobSha256 } from "./outbox.ts";
import type { PinController } from "./pinned-wallet.ts";

/** Lowercase hex (no `0x`) of a Uint8Array or hex string. */
export function bytesOrStringToHex(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex").toLowerCase();
  if (typeof value === "string") {
    const clean = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
    return clean.toLowerCase();
  }
  return String(value).toLowerCase();
}

interface OfferLike {
  inputs?: readonly { nullifier: unknown }[];
  transients?: readonly { nullifier: unknown }[];
}
interface TxLike {
  guaranteedOffer?: OfferLike | undefined;
  fallibleOffer?: { values?: () => Iterable<OfferLike | undefined> } | undefined;
}

/** Every shielded nullifier the transaction consumes: guaranteed + fallible, inputs + transients. */
export function collectNullifiers(tx: unknown): string[] {
  const t = tx as TxLike;
  const offers: OfferLike[] = [];
  if (t.guaranteedOffer) offers.push(t.guaranteedOffer);
  const fallible = t.fallibleOffer;
  if (fallible && typeof fallible.values === "function") {
    for (const offer of fallible.values.call(fallible)) if (offer) offers.push(offer);
  }
  const out: string[] = [];
  for (const offer of offers) {
    for (const input of offer.inputs ?? []) out.push(bytesOrStringToHex(input.nullifier));
    for (const transient of offer.transients ?? []) out.push(bytesOrStringToHex(transient.nullifier));
  }
  return out;
}

/** Inputs in FALLIBLE segments. An Offer File is a guaranteed single-segment swap: must be 0. */
export function countFallibleInputs(tx: unknown): number {
  const fallible = (tx as TxLike).fallibleOffer;
  if (fallible === undefined || fallible === null || typeof fallible.values !== "function") return 0;
  let count = 0;
  for (const offer of fallible.values.call(fallible)) count += offer?.inputs?.length ?? 0;
  return count;
}

/** A spendable shielded coin (public data). */
export interface CoinRef {
  readonly nonce: string;
  readonly type: string;
  readonly value: bigint;
  readonly nullifier: string;
}

export interface BuildOfferArgs {
  readonly giveColour: string;
  readonly giveAmount: bigint;
  /** The coin to pin: the offer's ONLY input. */
  readonly coin: CoinRef;
  readonly wantColour: string;
  readonly wantAmount: bigint;
  readonly ttlMs: number;
  readonly now: Date;
}

export interface FinalizedLike {
  serialize(): Uint8Array;
}

/**
 * The narrow wallet surface the builder needs. `WalletSession` implements it for real
 * (see `ladder-wallet.ts`); tests use fakes.
 */
export interface OfferWallet {
  readonly pins: Pick<PinController, "withPinnedCoin">;
  /** `initSwap` with the maker's own shielded address as the want receiver, `payFees: false`. */
  initSwap(args: { giveColour: string; giveAmount: bigint; wantColour: string; wantAmount: bigint; ttl: Date }): Promise<unknown>;
  finalize(recipe: unknown): Promise<FinalizedLike>;
  /** Release what a recipe reserved in the wallet's local state (`facade.revert`). */
  revert(recipe: unknown): Promise<void>;
}

export interface BuiltOffer {
  readonly recipe: unknown;
  readonly blob: string;
  readonly offerId: string;
  readonly blobSha256: string;
  readonly nullifiers: readonly string[];
  readonly fallibleInputCount: number;
  readonly builtAt: Date;
  readonly expiresAt: Date;
}

/** The finalized offer spends something other than exactly the pinned coin. */
export class WrongInputError extends Error {
  readonly expected: string;
  readonly got: readonly string[];
  readonly fallible: number;
  constructor(expected: string, got: readonly string[], fallible: number) {
    super(
      `expected exactly [${expected.slice(0, 16)}…], got [${got.map((n) => `${n.slice(0, 16)}…`).join(", ")}]` +
        (fallible === 0 ? "" : ` plus ${fallible} fallible input(s)`),
    );
    this.name = "WrongInputError";
    this.expected = expected;
    this.got = got;
    this.fallible = fallible;
  }
}

/** THE ASSERTION: exactly one input, exactly this coin's nullifier, nothing fallible. */
export function assertExactCoin(nullifiers: readonly string[], fallibleInputCount: number, coin: CoinRef): void {
  const expected = coin.nullifier.toLowerCase();
  const got = nullifiers.map((n) => n.toLowerCase());
  if (got.length !== 1 || got[0] !== expected || fallibleInputCount !== 0) throw new WrongInputError(expected, got, fallibleInputCount);
}

/**
 * pin → initSwap → finalize → encode → assert. On a failed assertion the recipe is
 * reverted and `WrongInputError` thrown; nothing leaves this function unasserted.
 * The pin is released in a `finally` (by `withPinnedCoin`).
 */
export async function buildPinnedOffer(wallet: OfferWallet, args: BuildOfferArgs): Promise<BuiltOffer> {
  if (args.coin.type.toLowerCase() !== args.giveColour.toLowerCase()) {
    throw new Error(`coin ${args.coin.nonce.slice(0, 12)}… is colour ${args.coin.type.slice(0, 12)}…, not the give colour`);
  }
  if (args.coin.value < args.giveAmount) {
    throw new Error(`coin ${args.coin.nonce.slice(0, 12)}… holds ${args.coin.value}, below the give amount ${args.giveAmount}`);
  }
  const expiresAt = new Date(args.now.getTime() + args.ttlMs);
  const recipe = await wallet.pins.withPinnedCoin(args.giveColour, args.coin.nonce, () =>
    wallet.initSwap({
      giveColour: args.giveColour,
      giveAmount: args.giveAmount,
      wantColour: args.wantColour,
      wantAmount: args.wantAmount,
      ttl: expiresAt,
    }),
  );
  let finalized: FinalizedLike;
  try {
    finalized = await wallet.finalize(recipe);
  } catch (error) {
    await wallet.revert(recipe).catch(() => undefined);
    throw error;
  }
  const nullifiers = collectNullifiers(finalized);
  const fallibleInputCount = countFallibleInputs(finalized);
  try {
    assertExactCoin(nullifiers, fallibleInputCount, args.coin);
  } catch (error) {
    await wallet.revert(recipe).catch(() => undefined);
    throw error;
  }
  let raw: Uint8Array;
  let blob: string;
  try {
    raw = finalized.serialize();
    blob = OfferFiles.encode(raw);
  } catch (error) {
    await wallet.revert(recipe).catch(() => undefined); // audit C3 verification: no leaked reservation
    throw error;
  }
  return {
    recipe,
    blob,
    offerId: OfferFiles.offerId(raw),
    blobSha256: blobSha256(blob),
    nullifiers,
    fallibleInputCount,
    builtAt: args.now,
    expiresAt,
  };
}
