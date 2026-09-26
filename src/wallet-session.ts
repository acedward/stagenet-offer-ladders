/**
 * A running wallet (wallet-sdk-facade 5.0.0-beta.2 built from its sub-packages; NO
 * `@midnight-ntwrk/testkit-js`, which logs the seed) whose shielded coin selection can be
 * pinned to one exact coin (`pinned-wallet.ts`).
 *
 * The facade wiring and the complete-sync wait are adapted from 00052's `src/wallet.ts`
 * (same repository), itself a port of `acedward/compact-multi-segment-emit`
 * `deploy-tools/wallet.ts` / `wallet-sync.ts` (Apache-2.0). The one change is the shielded
 * wallet: `CustomShieldedWallet(config, new V1Builder().withDefaults().withCoinSelection(
 * () => pins.selector))`, from `zswap-offerfiles-kernel` @ 67db767
 * `deploy/scripts/lib/pinned-wallet.ts` `buildPinnedShieldedWallet`.
 *
 * The mnemonic is passed in memory (from the mode-600 secrets file) and never printed.
 * One session per mnemonic at a time: two facades on one seed against one node disrupt
 * each other.
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import { NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { type FacadeState, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { CustomShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { V1Builder } from "@midnightntwrk/wallet-sdk-shielded/v1";
import { PublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { type Observable, Subscription } from "rxjs";

import { type WalletNetwork, wsUrl } from "./network.ts";
import { normHex, PinController } from "./pinned-wallet.ts";
import { deriveWalletKeys, publicIdentity, type PublicWalletIdentity, type WalletKeys } from "./wallets.ts";

// ---------------------------------------------------------------------------
// Complete sync (every sub-wallet caught up with the indexer, stable for N samples)
// ---------------------------------------------------------------------------

interface SubWalletProgress {
  readonly applied: bigint;
  readonly highest: bigint;
  readonly connected: boolean;
}
const SUB_WALLETS = ["shielded", "unshielded", "dust"] as const;
type SubWallet = (typeof SUB_WALLETS)[number];
export type WalletSyncProgress = Readonly<Record<SubWallet, SubWalletProgress>>;

const syncProgressOf = (state: FacadeState): WalletSyncProgress => ({
  shielded: {
    applied: state.shielded.progress.appliedIndex,
    highest: state.shielded.progress.highestRelevantWalletIndex,
    connected: state.shielded.progress.isConnected,
  },
  unshielded: {
    applied: state.unshielded.progress.appliedId,
    highest: state.unshielded.progress.highestTransactionId,
    connected: state.unshielded.progress.isConnected,
  },
  dust: {
    applied: state.dust.progress.appliedIndex,
    highest: state.dust.progress.highestRelevantWalletIndex,
    connected: state.dust.progress.isConnected,
  },
});

export const formatSyncProgress = (progress: WalletSyncProgress | undefined): string =>
  progress === undefined
    ? "no wallet state yet"
    : SUB_WALLETS.map((name) => {
        const item = progress[name];
        return item.connected ? `${name} ${item.applied}/${item.highest}` : `${name} not connected`;
      }).join(", ");

export const waitForCompleteSync = (
  states: Observable<FacadeState>,
  options: { timeoutMs?: number; sampleMs?: number; stableSamples?: number; log?: (line: string) => void } = {},
): Promise<{ state: FacadeState; progress: WalletSyncProgress; elapsedMs: number }> => {
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
  const sampleMs = options.sampleMs ?? 5_000;
  const stableSamples = options.stableSamples ?? 3;
  const log = options.log ?? (() => undefined);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const targets: Record<SubWallet, bigint> = { shielded: 0n, unshielded: 0n, dust: 0n };
    let latest: FacadeState | undefined;
    let latestProgress: WalletSyncProgress | undefined;
    let stable = 0;
    let lastLine = started;
    let finished = false;
    const subscription = new Subscription();
    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      subscription.unsubscribe();
      settle();
    };
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      const progress = latestProgress;
      const caughtUp =
        progress !== undefined &&
        SUB_WALLETS.every((name) => {
          const item = progress[name];
          const target = item.highest > targets[name] ? item.highest : targets[name];
          return item.connected && item.applied >= target;
        });
      stable = caughtUp ? stable + 1 : 0;
      if (stable >= stableSamples && latest !== undefined && progress !== undefined) {
        const state = latest;
        finish(() => resolve({ state, progress, elapsedMs: elapsed }));
        return;
      }
      if (elapsed >= timeoutMs) {
        finish(() => reject(new Error(`wallet not synced after ${elapsed} ms: ${formatSyncProgress(progress)}`)));
        return;
      }
      if (Date.now() - lastLine >= 30_000) {
        lastLine = Date.now();
        log(`wallet sync ${formatSyncProgress(progress)} (applied/highest), ${Math.round(elapsed / 1000)} s`);
      }
    }, sampleMs);
    subscription.add(
      states.subscribe({
        next: (state) => {
          latest = state;
          latestProgress = syncProgressOf(state);
          for (const name of SUB_WALLETS) {
            const item = latestProgress[name];
            if (item.connected && item.highest > targets[name]) targets[name] = item.highest;
          }
        },
        error: (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        complete: () => finish(() => reject(new Error("the wallet stopped before it was synced"))),
      }),
    );
  });
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A spendable shielded coin as the wallet reports it (public data). */
export interface SpendableCoin {
  /** 64 lowercase hex: the chain nonce. */
  readonly nonce: string;
  /** Token colour, 64 lowercase hex. */
  readonly type: string;
  readonly value: bigint;
  /** `coinNullifier(coin, coinSecretKey)`: what an offer spending this coin lists. */
  readonly nullifier: string;
}

/** Wallet balances after a sync (public data). */
export interface WalletBalances {
  /** Unshielded NIGHT, in STAR (10^-6 NIGHT). */
  readonly night: bigint;
  /** Spendable DUST now, in SPECK (10^-15 DUST). */
  readonly dust: bigint;
  readonly nightUtxos: readonly { value: bigint; ctime: string; registeredForDustGeneration: boolean }[];
  /** Shielded available balance by colour. */
  readonly shielded: Readonly<Record<string, bigint>>;
  /** Shielded available coin count by colour. */
  readonly shieldedCoins: Readonly<Record<string, number>>;
}

export interface WalletSessionOptions {
  readonly network: WalletNetwork;
  /** In memory only; never printed. */
  readonly mnemonic: string;
  readonly dustParameters: ledger.DustParameters;
  /** Fee headroom in blocks (default 5; a large margin burns DUST). */
  readonly feeBlocksMargin?: number;
  readonly syncTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

/** A running wallet with a per-wallet pin controller. Close it when done. */
export class WalletSession {
  readonly facade: WalletFacade;
  readonly identity: PublicWalletIdentity;
  readonly pins: PinController;
  readonly #keys: WalletKeys;
  readonly #log: (message: string) => void;
  readonly #syncTimeoutMs: number;

  private constructor(facade: WalletFacade, keys: WalletKeys, identity: PublicWalletIdentity, pins: PinController, options: WalletSessionOptions) {
    this.facade = facade;
    this.#keys = keys;
    this.identity = identity;
    this.pins = pins;
    this.#log = options.log ?? (() => undefined);
    this.#syncTimeoutMs = options.syncTimeoutMs ?? 60 * 60 * 1000;
  }

  static async open(options: WalletSessionOptions): Promise<WalletSession> {
    const margin = options.feeBlocksMargin ?? 5;
    if (!Number.isSafeInteger(margin) || margin < 0 || margin > 100) {
      throw new RangeError("feeBlocksMargin must be an integer from 0 to 100");
    }
    const { network } = options;
    const configuration = {
      networkId: network.networkId,
      indexerClientConnection: { indexerHttpUrl: network.indexerHttpUrl, indexerWsUrl: network.indexerWsUrl },
      provingServerUrl: new URL(network.proofServerUrl),
      relayURL: wsUrl(network.nodeUrl),
      costParameters: { feeBlocksMargin: margin },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    };
    const keys = deriveWalletKeys(options.mnemonic, network.networkId);
    const pins = new PinController();
    try {
      const identity = publicIdentity(keys, network.networkId);
      const facade = await WalletFacade.init({
        configuration: configuration as never,
        shielded: (config) =>
          CustomShieldedWallet(
            config as never,
            new V1Builder().withDefaults().withCoinSelection(() => pins.selector) as never,
          ).startWithSecretKeys(keys.shieldedSecretKeys) as never,
        unshielded: (config) =>
          UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keys.unshieldedKeystore)),
        dust: (config) => DustWallet(config).startWithSecretKey(keys.dustSecretKey, options.dustParameters),
      });
      try {
        await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
      } catch (error) {
        await facade.stop().catch(() => undefined); // audit C5: no half-started facade
        throw error;
      }
      return new WalletSession(facade, keys, identity, pins, options);
    } catch (error) {
      keys.clear();
      throw error;
    }
  }

  /** The secret keys `initSwap` / balancing need. Never log them. */
  get secretKeys(): { shieldedSecretKeys: ledger.ZswapSecretKeys; dustSecretKey: ledger.DustSecretKey } {
    return { shieldedSecretKeys: this.#keys.shieldedSecretKeys, dustSecretKey: this.#keys.dustSecretKey };
  }

  /** Sign unshielded segments of a recipe (DUST registration, unshielded inputs). */
  signData(data: Uint8Array): Promise<ledger.Signature> {
    return this.#keys.unshieldedKeystore.signDataAsync(data);
  }

  get unshieldedVerifyingKey(): ledger.SignatureVerifyingKey {
    return this.#keys.unshieldedKeystore.getPublicKey();
  }

  /** Wait for a complete sync of all three sub-wallets. */
  async synced(): Promise<FacadeState> {
    const { state, progress, elapsedMs } = await waitForCompleteSync(this.facade.state(), {
      timeoutMs: this.#syncTimeoutMs,
      log: this.#log,
    });
    this.#log(`wallet synced in ${Math.round(elapsedMs / 1000)} s: ${formatSyncProgress(progress)}`);
    return state;
  }

  /**
   * The first state in which every sub-wallet is connected and caught up with what it
   * has seen (one sample, no stability window): cheap enough to call every tick once the
   * wallet has completed its initial `synced()`.
   */
  async caughtUp(timeoutMs = 120_000): Promise<FacadeState> {
    return await new Promise<FacadeState>((resolve, reject) => {
      let done = false;
      let subscription: { unsubscribe(): void } | undefined;
      const finish = (settle: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        queueMicrotask(() => subscription?.unsubscribe());
        settle();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`wallet not caught up within ${timeoutMs} ms`))), timeoutMs);
      subscription = this.facade.state().subscribe({
        next: (state) => {
          const progress = syncProgressOf(state);
          const ok = SUB_WALLETS.every((name) => progress[name].connected && progress[name].applied >= progress[name].highest);
          if (ok) finish(() => resolve(state));
        },
        error: (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      });
    });
  }

  /** Current (not re-synced) facade state. */
  async current(): Promise<FacadeState> {
    return await new Promise<FacadeState>((resolve, reject) => {
      const subscription = this.facade.state().subscribe({
        next: (state) => {
          resolve(state);
          queueMicrotask(() => subscription.unsubscribe());
        },
        error: reject,
      });
    });
  }

  /** Spendable shielded coins (excludes coins the wallet holds as pending spends). */
  static spendableCoins(state: FacadeState): SpendableCoin[] {
    return (state.shielded.availableCoins as readonly { coin: { type: string; nonce: string; value: bigint }; nullifier: string }[]).map(
      (entry) => ({
        nonce: normHex(String(entry.coin.nonce)),
        type: normHex(String(entry.coin.type)),
        value: BigInt(entry.coin.value),
        nullifier: normHex(String(entry.nullifier)),
      }),
    );
  }

  /** Nonces of every coin the wallet still owns, spendable or held by a pending spend. */
  static ownedNonces(state: FacadeState): Set<string> {
    const out = new Set<string>();
    for (const coin of WalletSession.spendableCoins(state)) out.add(coin.nonce);
    const pending = (state.shielded as unknown as { state?: { state?: ledger.ZswapLocalState } }).state?.state?.pendingSpends;
    if (pending !== undefined) for (const [, [coin]] of pending) out.add(normHex(String(coin.nonce)));
    return out;
  }

  static balancesOf(state: FacadeState): WalletBalances {
    const night = ledger.nativeToken().raw;
    const shieldedCoins: Record<string, number> = {};
    for (const coin of WalletSession.spendableCoins(state)) shieldedCoins[coin.type] = (shieldedCoins[coin.type] ?? 0) + 1;
    return {
      night: state.unshielded.balances[night] ?? 0n,
      dust: state.dust.balance(new Date()),
      nightUtxos: state.unshielded.availableCoins
        .filter((coin) => coin.utxo.type === night)
        .map((coin) => ({
          value: coin.utxo.value,
          ctime: coin.meta.ctime.toISOString(),
          registeredForDustGeneration: coin.meta.registeredForDustGeneration,
        })),
      shielded: { ...state.shielded.balances },
      shieldedCoins,
    };
  }

  /**
   * Pay fees for a proven contract-call transaction, sign the balancing part and bind it
   * (midnight-js `WalletProvider.balanceTx`). Waits up to 10 min for enough DUST.
   * Same recipe as 00052's `src/wallet.ts` `balanceTx`.
   */
  async balanceTx(
    tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
    ttl?: Date,
  ): Promise<ledger.FinalizedTransaction> {
    const transactionTtl = ttl ?? new Date(Date.now() + 20 * 60 * 1000);
    const deadline = Date.now() + 600_000;
    for (;;) {
      try {
        await this.facade.estimateTransactionFee(tx, this.#keys.dustSecretKey, { ttl: transactionTtl });
        break;
      } catch (error) {
        const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (!/insufficient funds|could not balance dust/iu.test(text)) throw error;
        if (Date.now() >= deadline) throw new Error("timed out waiting for enough DUST for the fee");
        this.#log("waiting for the wallet to hold enough DUST for the fee");
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    const recipe = await this.facade.balanceUnboundTransaction(tx, this.secretKeys, { ttl: transactionTtl });
    const signed = await this.facade.signRecipe(recipe, (data) => this.signData(data));
    return await this.facade.finalizeRecipe(signed);
  }

  submitTx(tx: ledger.FinalizedTransaction): Promise<string> {
    return this.facade.submitTransaction(tx);
  }

  async close(): Promise<void> {
    try {
      await this.facade.stop();
    } finally {
      this.pins.unpin();
      this.#keys.clear();
    }
  }
}
