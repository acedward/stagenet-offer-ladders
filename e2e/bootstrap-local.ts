/**
 * Local e2e bootstrap (plan 00057 P2): stand-in tokens and the local book.
 *
 * Runs inside the harness's Compose network against a LOCAL `undeployed` chain only
 * (`e2e/local-books.sh`). With the funding wallet (`FUNDING_WALLET_FILE`):
 *
 * 1. deploys this repository's stkA and stkB token contracts as stand-ins for wStkA and wUSDC
 *    (same 6 decimals; open mint), recording nothing in `deployments/`;
 * 2. mints `--stock` whole stand-in wStkA and `--usdc` whole stand-in wUSDC to itself, one coin
 *    each, and waits until the wallet holds them;
 * 3. writes `$E2E_DIR/tokens.json` (colours, contracts, txs) and `$E2E_DIR/book.local.json`:
 *    the committed book's AASK and ABID ladders (`ladders/stagenet.usdc.json`) cut to the first
 *    `--levels` levels, on the stand-in colours (no bridge block) and on makers AB-01….
 *
 * Refuses any network other than `undeployed`. Prints public data only.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createUnprovenDeployTx, submitCallTx, submitTxAsync } from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxData } from "@midnight-ntwrk/midnight-js-types";
import { sampleSigningKey } from "@midnightntwrk/ledger-v9";

import { compiledContractFor, publicDataProviderFor, tokenProviders } from "../src/providers.ts";
import { bytesOfHex, colourByLedger, hexOf, type TokenId, tokenRow } from "../src/tokens.ts";
import { fetchLedgerParameters, stagenet, WalletSession } from "../src/wallet.ts";

const log = (event: string, fields: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms))]);

const STAND_INS: readonly { symbol: string; contract: TokenId; argument: string }[] = [
  { symbol: "wStkA", contract: "stkA", argument: "stock" },
  { symbol: "wUSDC", contract: "stkB", argument: "usdc" },
];

const main = async (): Promise<void> => {
  // 00052's `stagenet()` reads the endpoints from MN_* but fixes the network id; take ours from MN_NETWORK_ID.
  const network = { ...stagenet(), networkId: process.env["MN_NETWORK_ID"]?.trim() || "stagenet" };
  if (network.networkId !== "undeployed") throw new Error(`the e2e bootstrap runs on a local undeployed chain only (network is ${network.networkId})`);
  const dir = process.env["E2E_DIR"]?.trim() || "/e2e";
  const levels = Number(argument("levels", "2"));
  const { height, parameters } = await fetchLedgerParameters(network);
  log("ledger", { height });
  const session = await WalletSession.open({
    network,
    mnemonicFile: process.env["FUNDING_WALLET_FILE"]?.trim() || "/e2e/secrets/funder",
    dustParameters: parameters.dust,
    feeBlocksMargin: 5,
    syncTimeoutMs: 10 * 60_000,
    log: (line) => log("wallet", { line }),
  });
  const tokens: Record<string, { colour: string; contract: string; standInFor: string; deployTx: string; mintTx: string; minted: string }> = {};
  try {
    const before = await session.balances();
    log("funder", { unshieldedAddress: session.identity.unshieldedAddress, night: before.night, dust: before.dust });
    const publicData = publicDataProviderFor(network);
    for (const standIn of STAND_INS) {
      const providers = tokenProviders(standIn.contract, network, session, (line) => log("prove", { line }));
      const compiledContract = await compiledContractFor(standIn.contract);
      // The maintenance key of a throwaway local contract is not kept.
      const unsubmitted = await createUnprovenDeployTx(providers as never, { compiledContract, signingKey: sampleSigningKey() } as never);
      const address = unsubmitted.public.contractAddress;
      await submitTxAsync(providers as never, { unprovenTx: unsubmitted.private.unprovenTx });
      const deployed = (await withTimeout(publicData.watchForDeployTxData(address), 10 * 60_000, "deploy inclusion")) as FinalizedTxData;
      if (String(deployed.status) !== "SucceedEntirely") throw new Error(`${standIn.symbol} deploy: ${String(deployed.status)}`);
      const colour = colourByLedger(tokenRow(standIn.contract), address);
      log("deployed", { symbol: standIn.symbol, contract: address, colour, txHash: deployed.txHash, block: deployed.blockHeight });
      const amount = BigInt(argument(standIn.argument, standIn.argument === "stock" ? "2500" : "10")) * 1_000_000n;
      const recipient = { is_left: true, left: { bytes: bytesOfHex(session.identity.coinPublicKey) }, right: { bytes: new Uint8Array(32) } };
      const minted = (await withTimeout(
        submitCallTx(providers as never, { compiledContract, contractAddress: address, circuitId: "mint", args: [recipient, amount, new Uint8Array(randomBytes(32))] } as never),
        10 * 60_000,
        "mint inclusion",
      )) as { public: FinalizedTxData; private: { result: { color: Uint8Array; value: bigint } } };
      if (String(minted.public.status) !== "SucceedEntirely") throw new Error(`${standIn.symbol} mint: ${String(minted.public.status)}`);
      if (hexOf(minted.private.result.color) !== colour) throw new Error(`${standIn.symbol}: minted colour differs from the ledger's`);
      log("minted", { symbol: standIn.symbol, amount, txHash: minted.public.txHash, block: minted.public.blockHeight });
      tokens[standIn.symbol] = {
        colour,
        contract: address,
        standInFor: standIn.symbol,
        deployTx: String(deployed.txHash),
        mintTx: String(minted.public.txHash),
        minted: amount.toString(),
      };
    }
    // Wait until the wallet holds both minted coins.
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const balances = await session.balances();
      const ok = STAND_INS.every((s) => (balances.shielded[tokens[s.symbol]!.colour] ?? 0n) >= BigInt(tokens[s.symbol]!.minted));
      if (ok) {
        log("funder-balances", { shielded: Object.fromEntries(STAND_INS.map((s) => [s.symbol, balances.shielded[tokens[s.symbol]!.colour]])), dust: balances.dust });
        break;
      }
      if (Date.now() >= deadline) throw new Error("the minted stand-in coins did not reach the wallet");
      await new Promise((r) => setTimeout(r, 3_000));
    }
  } finally {
    await session.close().catch(() => undefined);
  }

  // The local book: the committed book's wStkA side, first `levels` levels, stand-in colours.
  const committed = JSON.parse(readFileSync("ladders/stagenet.usdc.json", "utf8")) as {
    ladders: { id: string; prices: string[]; wallets: string[] }[];
  };
  const pick = (id: string, firstWallet: number) => {
    const ladder = committed.ladders.find((l) => l.id === id)!;
    return {
      ...ladder,
      prices: ladder.prices.slice(0, levels),
      wallets: Array.from({ length: levels }, (_, i) => `AB-${String(firstWallet + i).padStart(2, "0")}`),
    };
  };
  const book = {
    version: 1,
    networkId: network.networkId,
    mode: "wallet-per-slot",
    coinPolicy: "at-least",
    tokens: {
      wStkA: { decimals: 6, colour: tokens["wStkA"]!.colour },
      wUSDC: { decimals: 6, colour: tokens["wUSDC"]!.colour },
    },
    ladders: [pick("AASK", 1), pick("ABID", levels + 1)],
  };
  writeFileSync(join(dir, "tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`);
  writeFileSync(join(dir, "book.local.json"), `${JSON.stringify(book, null, 2)}\n`);
  log("written", { tokens: join(dir, "tokens.json"), book: join(dir, "book.local.json"), ladders: book.ladders.map((l) => ({ id: l.id, prices: l.prices, wallets: l.wallets })) });
};

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`[bootstrap-local] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
