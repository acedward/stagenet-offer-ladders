/**
 * Funding-wallet session: a Midnight wallet (wallet-sdk-facade 5.0.0-beta.2, built from
 * its sub-packages; NO @midnight-ntwrk/testkit-js, which logs the wallet seed) opened
 * from a BIP-39 mnemonic that is read from a protected file at runtime.
 *
 * Adapted from `acedward/compact-multi-segment-emit` `deploy-tools/wallet.ts`,
 * `wallet-sync.ts` and `secrets.ts` (Apache-2.0), which ran this exact SDK set on
 * stagenet (node 2.0.0-d9729c13, ledger-v9 1.0.0-rc.3) in September 2026.
 *
 * Secrets policy:
 * - the mnemonic file is referenced by PATH only; it must be a regular file (not a
 *   symlink) that neither group nor others can access;
 * - it may hold the bare phrase or a `WALLET="<words>"` line (the owner's `.stagenet`);
 * - nothing derived from it is logged, returned for printing or written anywhere; error
 *   messages never quote the file; only public addresses, keys and balances are printed.
 *
 * Derivation: BIP-39 seed (64 bytes, empty passphrase, as Lace does), then the Midnight
 * HD tree at account 0, index 0 for the Zswap, NightExternal and Dust roles. This is the
 * derivation `zswap-offerfiles-kernel` uses for `*_MNEMONIC` (`deploy/scripts/lib/
 * poster-config.ts` `resolveSeed` + `pinned-wallet.ts` `deriveSeedForRole`).
 *
 * @module
 */
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync } from "node:fs";

import * as ledger from "@midnightntwrk/ledger-v9";
import { NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { type FacadeState, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { type Observable, Subscription } from "rxjs";

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Endpoints a wallet session talks to. */
export interface WalletNetwork {
  readonly networkId: string;
  readonly indexerHttpUrl: string;
  readonly indexerWsUrl: string;
  /** Node RPC (http(s)); the submission relay is the same host over ws(s). */
  readonly nodeUrl: string;
  /** Local proof server (the wallet proves its own fee inputs with it). */
  readonly proofServerUrl: string;
}

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

/** Stagenet, with per-endpoint environment overrides. */
export const stagenet = (): WalletNetwork => ({
  networkId: "stagenet",
  indexerHttpUrl: env("MN_INDEXER_URL", "https://indexer.stagenet.shielded.tools/api/v4/graphql"),
  indexerWsUrl: env("MN_INDEXER_WS_URL", "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws"),
  nodeUrl: env("MN_NODE_URL", "https://rpc.stagenet.shielded.tools"),
  proofServerUrl: env("MN_PROOF_SERVER_URL", "http://127.0.0.1:6300"),
});

const wsUrl = (httpUrl: string): URL => {
  const url = new URL(httpUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url;
};

/** The latest block's ledger parameters, from the indexer (public data). */
export const fetchLedgerParameters = async (
  network: WalletNetwork,
): Promise<{ height: number; parameters: ledger.LedgerParameters }> => {
  const response = await fetch(network.indexerHttpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ block { height ledgerParameters } }" }),
  });
  if (!response.ok) throw new Error(`indexer ledgerParameters query: HTTP ${response.status}`);
  const body = (await response.json()) as {
    data?: { block?: { height: number; ledgerParameters: string } };
  };
  const block = body.data?.block;
  if (!block?.ledgerParameters) throw new Error("indexer returned no ledger parameters");
  return {
    height: block.height,
    parameters: ledger.LedgerParameters.deserialize(Buffer.from(block.ledgerParameters, "hex")),
  };
};

// ---------------------------------------------------------------------------
// Mnemonic file
// ---------------------------------------------------------------------------

/** A problem with the mnemonic file. The message never contains file contents. */
export class SecretFileError extends Error {
  constructor(path: string, detail: string) {
    super(`secret file ${path}: ${detail}`);
    this.name = "SecretFileError";
  }
}

/**
 * Read and validate a BIP-39 mnemonic from a protected file holding either the bare
 * phrase or a `WALLET="<words>"` line.
 */
export const readMnemonicFile = (path: string): string => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SecretFileError(path, "does not exist or cannot be read");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SecretFileError(path, "must be a regular file (not a symlink)");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new SecretFileError(path, "must not be accessible by group or others (chmod 600)");
  }
  if (stats.size === 0 || stats.size > 4096) throw new SecretFileError(path, "has an unexpected size");
  const text = readFileSync(path, "utf8");
  const assignment = /^\s*(?:export\s+)?WALLET\s*=\s*(["']?)([^"'\r\n]*)\1\s*$/mu.exec(text);
  const raw = assignment ? assignment[2]! : text;
  const phrase = raw.trim().split(/\s+/u).join(" ").toLowerCase();
  const words = phrase.length === 0 ? 0 : phrase.split(" ").length;
  if (![12, 15, 18, 21, 24].includes(words)) {
    throw new SecretFileError(path, `holds ${String(words)} words; a BIP-39 mnemonic has 12-24`);
  }
  if (!validateMnemonic(phrase, english)) {
    throw new SecretFileError(path, "is not a valid English BIP-39 mnemonic (checksum or word)");
  }
  return phrase;
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * How the HD master seed is obtained from the mnemonic.
 * - `bip39` (default): the 64-byte BIP-39 seed, empty passphrase (Lace, the kernel).
 * - `entropy`: the mnemonic's 16–32-byte entropy (a fallback some tools use).
 */
export type SeedDerivation = "bip39" | "entropy";

/** Secret key material of a wallet (in memory only; call `clear` when done). */
export interface WalletKeys {
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly unshieldedKeystore: UnshieldedKeystore;
  clear(): void;
}

export const deriveWalletKeys = (
  mnemonic: string,
  networkId: string,
  derivation: SeedDerivation = "bip39",
  account = 0,
): WalletKeys => {
  const seed = derivation === "bip39" ? mnemonicToSeedSync(mnemonic) : mnemonicToEntropy(mnemonic, english);
  try {
    const hd = HDWallet.fromSeed(seed);
    if (hd.type !== "seedOk") throw new Error("wallet seed rejected by the HD derivation");
    try {
      const derived = hd.hdWallet
        .selectAccount(account)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
        .deriveKeysAt(0);
      if (derived.type !== "keysDerived") throw new Error("wallet key derivation out of bounds");
      const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
      const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
      const unshieldedKeystore = createKeystore(
        { kind: "schnorr", secret: derived.keys[Roles.NightExternal] },
        networkId,
      );
      for (const key of Object.values(derived.keys)) key.fill(0);
      return {
        shieldedSecretKeys,
        dustSecretKey,
        unshieldedKeystore,
        clear: () => {
          shieldedSecretKeys.clear();
          dustSecretKey.clear();
        },
      };
    } finally {
      hd.hdWallet.clear();
    }
  } finally {
    seed.fill(0);
  }
};

/** Public identity of a wallet: safe to print and record. */
export interface PublicWalletIdentity {
  readonly networkId: string;
  readonly unshieldedAddress: string;
  readonly shieldedAddress: string;
  readonly dustAddress: string;
  /** Zswap coin public key, hex (a shielded mint's recipient). */
  readonly coinPublicKey: string;
  /** Zswap encryption public key, hex. */
  readonly encryptionPublicKey: string;
}

export const publicIdentity = (keys: WalletKeys, networkId: string): PublicWalletIdentity => {
  const coinPublicKey = keys.shieldedSecretKeys.coinPublicKey;
  const encryptionPublicKey = keys.shieldedSecretKeys.encryptionPublicKey;
  const shielded = new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(coinPublicKey, "hex")),
    new ShieldedEncryptionPublicKey(Buffer.from(encryptionPublicKey, "hex")),
  );
  return {
    networkId,
    unshieldedAddress: keys.unshieldedKeystore.getBech32Address().asString(),
    shieldedAddress: MidnightBech32m.encode(networkId, shielded).asString(),
    dustAddress: DustAddress.encodePublicKey(networkId, keys.dustSecretKey.publicKey),
    coinPublicKey,
    encryptionPublicKey,
  };
};

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
type WalletSyncProgress = Readonly<Record<SubWallet, SubWalletProgress>>;

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

/** Wallet balances after a sync (public data). */
export interface WalletBalances {
  /** Unshielded NIGHT, in STAR (10^-6 NIGHT). */
  readonly night: bigint;
  /** Spendable DUST now, in SPECK (10^-15 DUST). */
  readonly dust: bigint;
  readonly nightUtxos: readonly { value: bigint; ctime: string; registeredForDustGeneration: boolean }[];
  /** Shielded balance by raw token type (colour). */
  readonly shielded: Readonly<Record<string, bigint>>;
  /** Shielded available coin count by colour. */
  readonly shieldedCoins: Readonly<Record<string, number>>;
  /** Every available shielded coin (public: colour, nonce, value). */
  readonly shieldedCoinList: readonly { colour: string; nonce: string; value: bigint }[];
}

export interface WalletSessionOptions {
  readonly network: WalletNetwork;
  /** Path of the protected mnemonic file (read here; never printed). */
  readonly mnemonicFile: string;
  readonly derivation?: SeedDerivation;
  readonly account?: number;
  /** DUST parameters (from the network's current ledger parameters). */
  readonly dustParameters: ledger.DustParameters;
  /**
   * Fee headroom in blocks (default 5). The ledger consumes the whole declared fee
   * (`required × 1.046^margin` on stagenet), so a large margin burns DUST.
   */
  readonly feeBlocksMargin?: number;
  readonly syncTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** A running wallet. Close it when done; never run two sessions on one mnemonic. */
export class WalletSession {
  readonly identity: PublicWalletIdentity;
  readonly facade: WalletFacade;
  readonly #keys: WalletKeys;
  readonly #log: (message: string) => void;
  readonly #syncTimeoutMs: number;

  private constructor(facade: WalletFacade, keys: WalletKeys, identity: PublicWalletIdentity, options: WalletSessionOptions) {
    this.facade = facade;
    this.#keys = keys;
    this.identity = identity;
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
    const keys = deriveWalletKeys(
      readMnemonicFile(options.mnemonicFile),
      network.networkId,
      options.derivation ?? "bip39",
      options.account ?? 0,
    );
    try {
      const identity = publicIdentity(keys, network.networkId);
      const facade = await WalletFacade.init({
        configuration: configuration as never,
        shielded: (config) => ShieldedWallet(config).startWithSecretKeys(keys.shieldedSecretKeys),
        unshielded: (config) =>
          UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keys.unshieldedKeystore)),
        dust: (config) => DustWallet(config).startWithSecretKey(keys.dustSecretKey, options.dustParameters),
      });
      await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
      return new WalletSession(facade, keys, identity, options);
    } catch (error) {
      keys.clear();
      throw error;
    }
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

  async balances(): Promise<WalletBalances> {
    const state = await this.synced();
    const night = ledger.nativeToken().raw;
    const shieldedCoins: Record<string, number> = {};
    const shieldedCoinList: { colour: string; nonce: string; value: bigint }[] = [];
    for (const available of state.shielded.availableCoins) {
      const { type, nonce, value } = available.coin;
      shieldedCoins[type] = (shieldedCoins[type] ?? 0) + 1;
      shieldedCoinList.push({ colour: type, nonce, value });
    }
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
      shieldedCoinList,
    };
  }

  async #waitForFeeBudget(
    tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
    ttl: Date,
    waitMs: number,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;
    let announced = false;
    for (;;) {
      try {
        await this.facade.estimateTransactionFee(tx, this.#keys.dustSecretKey, { ttl });
        return;
      } catch (error) {
        if (!/insufficient funds|could not balance dust/i.test(errorText(error))) throw error;
      }
      if (!announced) {
        this.#log("waiting for the wallet to hold enough DUST for the fee");
        announced = true;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for enough DUST for the fee");
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  /** Pay fees for a proven transaction, sign the balancing part and bind it. */
  async balanceTx(
    tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
    ttl?: Date,
  ): Promise<ledger.FinalizedTransaction> {
    const transactionTtl = ttl ?? new Date(Date.now() + 20 * 60 * 1000);
    await this.#waitForFeeBudget(tx, transactionTtl, 600_000);
    const recipe = await this.facade.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: this.#keys.shieldedSecretKeys, dustSecretKey: this.#keys.dustSecretKey },
      { ttl: transactionTtl },
    );
    const signed = await this.facade.signRecipe(recipe, (data) => this.#keys.unshieldedKeystore.signDataAsync(data));
    return await this.facade.finalizeRecipe(signed);
  }

  submitTx(tx: ledger.FinalizedTransaction): Promise<string> {
    return this.facade.submitTransaction(tx);
  }

  async close(): Promise<void> {
    try {
      await this.facade.stop();
    } finally {
      this.#keys.clear();
    }
  }
}
