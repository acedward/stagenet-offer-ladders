/**
 * Real wallet adapters for the scheduler's `WalletPort`, over `WalletSession`.
 *
 * Two modes (spec Q1 resolution):
 * - `wallet-per-slot` (production): slot `AB-01` uses maker wallet `AB-01` from the
 *   mode-600 makers file. Sessions are opened lazily, one at a time with a stagger, and
 *   kept open (each re-sync of a fresh facade costs ~1-2 min against the public indexer).
 * - `single-wallet-pinned` (the owner's test and "future B"): every slot uses ONE wallet
 *   (the funding wallet file, walletId `funding`), each slot pinned to a distinct coin.
 *
 * @module
 */
import type * as ledger from "@midnightntwrk/ledger-v9";

import type { WalletNetwork } from "./network.ts";
import { buildPinnedOffer, type BuildOfferArgs, type BuiltOffer, type FinalizedLike, type OfferWallet } from "./offer-builder.ts";
import type { LadderWallet, WalletPort, WalletSnapshot } from "./scheduler.ts";
import { WalletSession } from "./wallet-session.ts";

export const FUNDING_WALLET_ID = "funding";

/** The builder's narrow wallet port, over a running session. */
export const offerWalletOf = (session: WalletSession): OfferWallet => ({
  pins: session.pins,
  async initSwap(args) {
    // The ADDRESS OBJECT, not a string (kernel `maker-offer.ts` header).
    const own = await session.facade.shielded.getAddress();
    return await session.facade.initSwap(
      { shielded: { [args.giveColour]: args.giveAmount } },
      [{ type: "shielded", outputs: [{ type: args.wantColour, amount: args.wantAmount, receiverAddress: own }] } as never],
      session.secretKeys,
      // payFees:false — an Offer File is settled (and paid for) by whoever takes it.
      { ttl: args.ttl, payFees: false },
    );
  },
  async finalize(recipe) {
    const r = recipe as { transaction: ledger.UnprovenTransaction };
    return (await session.facade.finalizeTransaction(r.transaction)) as unknown as FinalizedLike;
  },
  async revert(recipe) {
    await session.facade.revert(recipe as never);
  },
});

export const ladderWalletOf = (walletId: string, session: WalletSession, caughtUpTimeoutMs = 120_000): LadderWallet => ({
  walletId,
  async snapshot(): Promise<WalletSnapshot> {
    const state = await session.caughtUp(caughtUpTimeoutMs);
    return { spendable: WalletSession.spendableCoins(state), owned: WalletSession.ownedNonces(state) };
  },
  build(args: BuildOfferArgs): Promise<BuiltOffer> {
    return buildPinnedOffer(offerWalletOf(session), args);
  },
  async release(recipe: unknown): Promise<void> {
    await session.facade.revert(recipe as never);
  },
});

export interface SessionFactoryOptions {
  readonly network: WalletNetwork;
  readonly dustParameters: ledger.DustParameters;
  readonly log: (line: string) => void;
  readonly syncTimeoutMs?: number;
}

/** What the pool needs from a session (a `WalletSession`, or a fake in tests). */
export interface PoolSession {
  synced(): Promise<unknown>;
  close(): Promise<void>;
}

/** A pool of lazily opened, kept-open sessions keyed by wallet id. */
export class SessionPool implements WalletPort {
  readonly #mnemonics: ReadonlyMap<string, string>;
  readonly #options: SessionFactoryOptions;
  readonly #staggerMs: number;
  readonly #sessions = new Map<string, Promise<{ session: WalletSession; wallet: LadderWallet }>>();
  readonly #open: (walletId: string, mnemonic: string) => Promise<WalletSession>;
  #lastOpenAt = 0;
  #opening: Promise<unknown> = Promise.resolve();

  constructor(
    mnemonics: ReadonlyMap<string, string>,
    options: SessionFactoryOptions,
    staggerMs = 5_000,
    open?: (walletId: string, mnemonic: string) => Promise<WalletSession>,
  ) {
    this.#mnemonics = mnemonics;
    this.#options = options;
    this.#staggerMs = staggerMs;
    this.#open =
      open ??
      ((walletId, mnemonic) =>
        WalletSession.open({
          network: this.#options.network,
          mnemonic,
          dustParameters: this.#options.dustParameters,
          syncTimeoutMs: this.#options.syncTimeoutMs ?? 20 * 60 * 1000,
          log: (line) => this.#options.log(`${walletId}: ${line}`),
        }));
  }

  get(walletId: string): Promise<LadderWallet> {
    let entry = this.#sessions.get(walletId);
    if (entry === undefined) {
      const mnemonic = this.#mnemonics.get(walletId);
      if (mnemonic === undefined) return Promise.reject(new Error(`no wallet ${walletId} in the secrets file`));
      // Open one at a time, staggered: 20 fresh syncs at once would hammer the indexer.
      const opened = this.#opening.then(async () => {
        const wait = this.#lastOpenAt + this.#staggerMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.#lastOpenAt = Date.now();
        const session = await this.#open(walletId, mnemonic);
        try {
          await session.synced();
        } catch (error) {
          // Audit C5: never leave a running facade behind a failed sync; a retry would
          // otherwise open a second facade on the same seed.
          await session.close().catch(() => undefined);
          throw error;
        }
        return { session, wallet: ladderWalletOf(walletId, session) };
      });
      this.#opening = opened.catch(() => undefined);
      entry = opened;
      this.#sessions.set(walletId, entry);
      opened.catch(() => this.#sessions.delete(walletId));
    }
    return entry.then((e) => e.wallet);
  }

  /** The open session of `walletId`, if any (for settle / status tools). */
  async session(walletId: string): Promise<WalletSession> {
    await this.get(walletId);
    return (await this.#sessions.get(walletId)!).session;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const entry of entries) {
      try {
        await (await entry).session.close();
      } catch {
        /* closing a failed session */
      }
    }
  }
}
