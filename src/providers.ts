/**
 * midnight-js 5.0.0-beta.7 providers for one stk token contract, built directly (no
 * testkit): indexer public data, the contract's committed ZK artefacts, the local proof
 * server (with a bounded retry on 408/429/connection resets and one proof at a time),
 * and the funding wallet as wallet and submission provider.
 *
 * @module
 */
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type {
  MidnightProvider,
  ProofProvider,
  PublicDataProvider,
  WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";

import { managedDirectory, type TokenId } from "./tokens.ts";
import type { WalletNetwork, WalletSession } from "./wallet.ts";

/** The generated contract module (`contracts/managed/<id>/contract/index.js`). */
export interface TokenContractModule {
  readonly Contract: new (witnesses: object) => unknown;
  ledger(state: unknown): { _published: boolean; _mints: bigint };
}

export const loadContractModule = async (id: TokenId): Promise<TokenContractModule> =>
  (await import(`${managedDirectory(id)}/contract/index.js`)) as TokenContractModule;

export const compiledContractFor = async (id: TokenId) => {
  const module = await loadContractModule(id);
  return CompiledContract.make(id, module.Contract as never).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(managedDirectory(id) as never),
  ) as never;
};

export const publicDataProviderFor = (network: WalletNetwork): PublicDataProvider => {
  setNetworkId(network.networkId);
  return indexerPublicDataProvider({ queryURL: network.indexerHttpUrl, subscriptionURL: network.indexerWsUrl });
};

const retryable = (error: unknown): boolean =>
  /\b(408|429)\b|ECONNRESET|socket hang up|other side closed|fetch failed|ETIMEDOUT/i.test(
    error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error),
  );

/** The proof server, one proof at a time, with up to 4 attempts on transient errors. */
export const proofProviderFor = (network: WalletNetwork, id: TokenId, log: (line: string) => void): ProofProvider => {
  const inner = httpClientProofProvider({
    url: network.proofServerUrl,
    zkConfigProvider: new NodeZkConfigProvider(managedDirectory(id)),
    timeout: 600_000,
  });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    proveTx: (tx, config) => {
      const run = async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await inner.proveTx(tx, config);
          } catch (error) {
            if (attempt >= 4 || !retryable(error)) throw error;
            log(`proof attempt ${attempt} failed transiently; retrying in ${attempt * 5} s`);
            await new Promise((r) => setTimeout(r, attempt * 5_000));
          }
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
};

/** The funding wallet as midnight-js' wallet provider and submission provider. */
export const walletProvidersFor = (session: WalletSession): WalletProvider & MidnightProvider => ({
  getCoinPublicKey: () => session.identity.coinPublicKey as never,
  getEncryptionPublicKey: () => session.identity.encryptionPublicKey as never,
  balanceTx: (tx, ttl) => session.balanceTx(tx as never, ttl) as never,
  submitTx: (tx) => session.submitTx(tx as never) as never,
});

/** Every provider a deploy or call needs (these contracts have no private state). */
export const tokenProviders = (
  id: TokenId,
  network: WalletNetwork,
  session: WalletSession,
  log: (line: string) => void,
) => {
  const wallet = walletProvidersFor(session);
  return {
    publicDataProvider: publicDataProviderFor(network),
    zkConfigProvider: new NodeZkConfigProvider(managedDirectory(id)),
    proofProvider: proofProviderFor(network, id, log),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
};
