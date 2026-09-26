/**
 * Real `MakerOps` over a maker's `WalletSession` (see `makers.ts` for the rules).
 *
 * - DUST registration: the recipe of `registerNightForDust` in
 *   `@effectstream/midnight-contracts@0.200.6` (`src/get-wallet-info.ts`), with the
 *   wallet-sdk facade directly: `estimateRegistration` → `waitForGeneratedDust(fee)` →
 *   `registerNightUtxosForDustGeneration` → `finalizeRecipe` → `submitTransaction`.
 * - Inventory mint: 00052's contract path (`src/providers.ts`, `scripts/mint.ts`):
 *   `submitCallTx(mint(self, amount, nonce))` on the give token's contract, fees from the
 *   maker's DUST (fee margin 5).
 *
 * @module
 */
import { submitCallTx } from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxData } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/ledger-v9";

import type { MakerOps, MakerStatus } from "./makers.ts";
import type { WalletNetwork } from "./network.ts";
import { compiledContractFor, tokenProviders } from "./providers.ts";
import { withTimeout } from "./scheduler.ts";
import { bytesOfHex, hexOf, type TokenId } from "./tokens.ts";
import { WalletSession } from "./wallet-session.ts";

export interface OpenMakerOptions {
  readonly network: WalletNetwork;
  readonly dustParameters: ledger.DustParameters;
  readonly mnemonic: string;
  readonly giveToken: TokenId;
  readonly giveColour: string;
  readonly contractAddress: string;
  readonly log: (line: string) => void;
  readonly registrationTimeoutMs?: number;
}

export const openMakerOps = async (options: OpenMakerOptions): Promise<MakerOps> => {
  const session = await WalletSession.open({
    network: options.network,
    mnemonic: options.mnemonic,
    dustParameters: options.dustParameters,
    feeBlocksMargin: 5,
    syncTimeoutMs: 20 * 60 * 1000,
    log: options.log,
  });
  try {
    await session.synced();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  const night = ledger.nativeToken().raw;
  const unregistered = async () => {
    const state = await session.caughtUp();
    return state.unshielded.availableCoins.filter((c) => c.utxo.type === night && !c.meta.registeredForDustGeneration);
  };
  return {
    async status(): Promise<MakerStatus> {
      const state = await session.caughtUp();
      const balances = WalletSession.balancesOf(state);
      return {
        nightUtxos: balances.nightUtxos.map((u) => ({ value: u.value, registered: u.registeredForDustGeneration })),
        dust: balances.dust,
        giveBalance: balances.shielded[options.giveColour] ?? 0n,
      };
    },
    async registerDust() {
      const utxos = await unregistered();
      if (utxos.length === 0) throw new Error("no unregistered NIGHT UTxO");
      const { fee } = await session.facade.estimateRegistration(utxos);
      options.log(`registration fee ${fee} SPECK; waiting for the UTxOs to generate it`);
      await session.facade.waitForGeneratedDust(utxos, fee, { timeoutMs: options.registrationTimeoutMs ?? 30 * 60_000 });
      const recipe = await session.facade.registerNightUtxosForDustGeneration(utxos, session.unshieldedVerifyingKey, (data) =>
        session.signData(data),
      );
      if (recipe.type !== "UNPROVEN_TRANSACTION") throw new Error(`unexpected DUST registration recipe ${recipe.type}`);
      const txId = await session.facade.submitTransaction(await session.facade.finalizeRecipe(recipe));
      return { txId: String(txId) };
    },
    async holdsCoin(nonce: string) {
      const state = await session.caughtUp();
      return WalletSession.ownedNonces(state).has(nonce.toLowerCase());
    },
    async mintGive(amount: bigint, nonceHex: string) {
      const providers = tokenProviders(options.giveToken, options.network, session as never, options.log);
      const compiledContract = await compiledContractFor(options.giveToken);
      const recipient = {
        is_left: true,
        left: { bytes: bytesOfHex(session.identity.coinPublicKey) },
        right: { bytes: new Uint8Array(32) },
      };
      const nonce = bytesOfHex(nonceHex);
      if (nonce.length !== 32) throw new Error("mint nonce must be 32 bytes");
      const result = (await withTimeout(submitCallTx(providers as never, {
        compiledContract,
        contractAddress: options.contractAddress,
        circuitId: "mint",
        args: [recipient, amount, nonce],
      } as never), 15 * 60_000, "inventory mint")) as { public: FinalizedTxData; private: { result: { nonce: Uint8Array; color: Uint8Array; value: bigint } } };
      const coin = result.private.result;
      if (hexOf(coin.color) !== options.giveColour) throw new Error(`minted colour ${hexOf(coin.color)} != ${options.giveColour}`);
      return {
        txHash: String(result.public.txHash),
        blockHeight: result.public.blockHeight,
        status: String(result.public.status),
        coinNonce: hexOf(coin.nonce),
      };
    },
    async close() {
      await session.close();
    },
  };
};
