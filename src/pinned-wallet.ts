/**
 * Exact-coin pinning for the shielded wallet's coin selection.
 *
 * Vendored from `effectstream/zswap-offerfiles-kernel` @ 67db767ed7b7c8f9167bad7197ff01ffb58fd39e,
 * `deploy/scripts/lib/pinned-wallet.ts` (Apache-2.0), and adapted:
 * - the selector (`createPinnedSelector`) and its contract are unchanged;
 * - the kernel keeps ONE module-level armed cell (one facade per process). This service
 *   runs up to one facade per ladder slot in one process, so the cell is per wallet:
 *   `PinController`, one per facade, with the same `pin` / `unpin` / `isPinned` /
 *   `pinnedCoin` / `withPinnedCoin` semantics;
 * - the facade is built from the wallet-sdk packages directly (see `wallet-session.ts`),
 *   not through `@effectstream/midnight-contracts` (it pins midnight-js beta.6).
 *
 * The injection point (unchanged): `CustomShieldedWallet(config,
 * new V1Builder().withDefaults().withCoinSelection(() => selector))`. `withDefaults()`
 * ends in `withCoinSelection(() => chooseCoin)`, so appending ours overwrites exactly that
 * entry and nothing else.
 *
 * Selector contract (the safety property the service rests on):
 *   * armed AND the requested `tokenType` is the armed type
 *         → the coin whose nonce is the armed nonce, or `undefined`. NEVER another coin.
 *           `undefined` makes the SDK throw `InsufficientFundsError`, which fails the build
 *           loudly instead of silently spending a different coin.
 *   * anything else (not armed, or another colour, including the fee token `''`)
 *         → the SDK's own `chooseCoin`, unchanged.
 *
 * @module
 */
import type { QualifiedShieldedCoinInfo } from "@midnightntwrk/ledger-v9";
import { type CoinSelection, chooseCoin } from "@midnightntwrk/wallet-sdk-capabilities";

/** The coin the selector is pinned to; lowercase hex without `0x`. */
export interface PinnedCoinRef {
  readonly tokenType: string;
  readonly nonce: string;
}

/** Coin selection over the shielded wallet's spendable coins. */
export type ShieldedCoinSelection = CoinSelection<QualifiedShieldedCoinInfo>;

const HEX64 = /^[0-9a-f]{64}$/u;

/** Lowercase, `0x`-stripped. Applied to both sides of every comparison. */
export function normHex(value: string): string {
  const s = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return s.toLowerCase();
}

function requireHex64(label: string, value: string): string {
  const normalised = normHex(value);
  if (!HEX64.test(normalised)) {
    throw new Error(`pinned-wallet: ${label} must be 64 lowercase hex chars (32 bytes), got ${JSON.stringify(value)}`);
  }
  return normalised;
}

/**
 * Build a coin selector that honours an armed coin. `getArmed` is read per call, so one
 * selector handed to the SDK at build time sees later `pin` calls.
 */
export function createPinnedSelector(
  getArmed: () => PinnedCoinRef | null,
  fallback: ShieldedCoinSelection = chooseCoin,
): ShieldedCoinSelection {
  return (coins, tokenType, amountNeeded, costModel) => {
    const armed = getArmed();
    if (armed !== null && armed.tokenType === normHex(tokenType)) {
      // Match on nonce AND type: an armed nonce naming a coin of another colour must
      // never be returned.
      return coins.find((coin) => normHex(coin.nonce) === armed.nonce && normHex(coin.type) === armed.tokenType);
    }
    return fallback(coins, tokenType, amountNeeded, costModel);
  };
}

/** The armed cell of ONE wallet facade, plus the selector bound to it. */
export class PinController {
  #armed: PinnedCoinRef | null = null;
  /** Hand this to `V1Builder.withCoinSelection(() => selector)`. */
  readonly selector: ShieldedCoinSelection;

  constructor(fallback: ShieldedCoinSelection = chooseCoin) {
    this.selector = createPinnedSelector(() => this.#armed, fallback);
  }

  /** Arm the selector. Throws when already armed (a nested pin means a missing unpin). */
  pin(tokenType: string, nonce: string): void {
    if (this.#armed !== null) {
      throw new Error(
        `pinned-wallet: already pinned to nonce ${this.#armed.nonce} (type ${this.#armed.tokenType}); ` +
          `unpin() before pinning ${normHex(nonce)}`,
      );
    }
    this.#armed = { tokenType: requireHex64("tokenType", tokenType), nonce: requireHex64("nonce", nonce) };
  }

  /** Disarm. Idempotent, so it is safe in a `finally`. */
  unpin(): void {
    this.#armed = null;
  }

  isPinned(): boolean {
    return this.#armed !== null;
  }

  pinnedCoin(): PinnedCoinRef | null {
    return this.#armed;
  }

  /** `pin` → run → `unpin` in a `finally`. */
  async withPinnedCoin<T>(tokenType: string, nonce: string, fn: () => Promise<T>): Promise<T> {
    this.pin(tokenType, nonce);
    try {
      return await fn();
    } finally {
      this.unpin();
    }
  }
}
