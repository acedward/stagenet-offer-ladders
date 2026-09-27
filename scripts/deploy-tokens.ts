/**
 * Deploy stkA / stkB / stkC to stagenet and publish their MIP-0018 metadata.
 *
 *   FUNDING_WALLET_FILE=/secrets/stagenet MN_PROOF_SERVER_URL=http://127.0.0.1:6300 \
 *     bun scripts/deploy-tokens.ts [stkA stkB stkC]
 *   (normally through scripts/stagenet-run.sh, which starts and removes the proof server)
 *
 * A port of acedward/mip-0018-midnight-contracts' scripts/deploy-and-publish.ts WITHOUT
 * @midnight-ntwrk/testkit-js (it logs the wallet seed):
 * - the funding wallet is built from the wallet-sdk sub-packages (src/wallet.ts), fee
 *   margin 5;
 * - the deploy is split so the contract ADDRESS is recorded in deployments/stagenet.json
 *   BEFORE the transaction is submitted (a crash cannot lose a paid-for deployment):
 *   createUnprovenDeployTx → record → submitTxAsync → watchForDeployTxData;
 * - each contract's maintenance signing key is written to a mode-600 file under
 *   $STK_STATE_DIR/maintenance/ before the deploy is built; only its verifying key is
 *   recorded;
 * - resumable per token and per step: a re-run skips what the record (and the chain)
 *   shows done, and does not open the wallet at all when nothing is left to do;
 * - the colour is taken from the contract's own `tokenColor()` circuit, executed locally
 *   against the on-chain contract state (no transaction), and checked against the
 *   ledger's `rawTokenType(domainSep, address)` and the `persistentCommit` formula.
 *
 * Prints public data only.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import {
  createUnprovenCallTx,
  createUnprovenDeployTx,
  submitCallTx,
  submitTxAsync,
} from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxData, PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import { sampleSigningKey, signatureVerifyingKey } from "@midnightntwrk/ledger-v9";

import { compiledContractFor, loadContractModule, publicDataProviderFor, tokenProviders } from "../src/providers.ts";
import { stateDir, takeFundingLock, writeSecretFile } from "../src/state.ts";
import {
  colourByFormula,
  colourByLedger,
  type Deployment,
  hexOf,
  isTokenId,
  parseDeployArgs,
  loadDeployment,
  managedDirectory,
  saveDeployment,
  type TokenId,
  type TokenRecord,
  tokenRows,
  type TxRecord,
} from "../src/tokens.ts";
import { fetchLedgerParameters, stagenet, WalletSession } from "../src/wallet.ts";

const EXPECTED_NODE_VERSION = "2.0.0-d9729c13";

const log = (event: string, fields: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
const progress = (line: string): void => log("progress", { line });

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms)),
  ]);

const nodeVersion = async (nodeUrl: string): Promise<string> => {
  const response = await fetch(nodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_version", params: [] }),
  });
  return ((await response.json()) as { result: string }).result;
};

const txRecord = (data: FinalizedTxData): TxRecord => ({
  txId: data.txId,
  txHash: data.txHash,
  identifiers: [...data.identifiers],
  blockHeight: Number(data.blockHeight),
  blockHash: data.blockHash,
  blockTimestamp: new Date(Number(data.blockTimestamp)).toISOString(),
  status: String(data.status),
  fees: data.fees ? { paidFees: String(data.fees.paidFees), estimatedFees: String(data.fees.estimatedFees) } : undefined,
  at: new Date().toISOString(),
});

const manifestSha256 = (id: TokenId): string =>
  createHash("sha256").update(readFileSync(join(managedDirectory(id), "compiler", "contract-manifest.json"))).digest("hex");

const deployed = (record: TokenRecord | undefined): boolean => record?.deployStatus === "SucceedEntirely";
const published = (record: TokenRecord | undefined): boolean =>
  record?.publishMetadata?.status === "SucceedEntirely";
const complete = (record: TokenRecord | undefined): boolean =>
  deployed(record) && published(record) && record?.colourChecks?.equal === true && record.tokenColor !== undefined;

/** Reconcile a record with the chain without the wallet (crash recovery). */
const reconcile = async (
  record: TokenRecord,
  publicData: PublicDataProvider,
  save: () => void,
): Promise<void> => {
  if (!record.address) return;
  const module = await loadContractModule(record.id);
  if (!deployed(record)) {
    const state = await publicData.queryContractState(record.address);
    if (state) {
      log("reconcile.deploy.found", { token: record.id, address: record.address });
      const data = await withTimeout(publicData.watchForDeployTxData(record.address), 120_000, "deploy tx lookup");
      record.deploy = txRecord(data);
      record.deployStatus = String(data.status);
      save();
    } else if (record.deployStatus === "built") {
      // Not visible (yet): it may still have been broadcast. Recorded, not replaced (audit C9).
      log("reconcile.deploy.not-visible", { token: record.id, address: record.address });
    }
  }
  if (deployed(record) && !published(record)) {
    const state = await publicData.queryContractState(record.address);
    if (state && module.ledger(state.data)._published) {
      log("reconcile.publish.found-on-chain", { token: record.id });
      record.publishMetadata = {
        txId: "unknown",
        txHash: "unknown (published on chain; the transaction was not recorded)",
        blockHeight: 0,
        status: "SucceedEntirely",
        at: new Date().toISOString(),
      };
      save();
    }
  }
};

async function main(): Promise<void> {
  const network = stagenet();
  const { tokens: requested, force } = parseDeployArgs(process.argv.slice(2));
  const rows = tokenRows().filter((row) => requested.length === 0 || requested.includes(row.id));

  const version = await nodeVersion(network.nodeUrl);
  log("network", { nodeVersion: version, indexer: network.indexerHttpUrl, proofServer: network.proofServerUrl });
  if (version !== EXPECTED_NODE_VERSION) {
    throw new Error(`stagenet runs ${version}; this SDK set is pinned for ${EXPECTED_NODE_VERSION}. Stop.`);
  }

  const deployment: Deployment = loadDeployment({
    name: "stagenet",
    networkId: network.networkId,
    node: network.nodeUrl,
    indexer: network.indexerHttpUrl,
  });
  deployment.network.nodeVersion = version;
  const save = (): void => saveDeployment(deployment);
  const publicData = publicDataProviderFor(network);

  const records: TokenRecord[] = rows.map((row) => {
    const record: TokenRecord = deployment.tokens[row.id] ?? {
      id: row.id,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      domain: row.domain,
      domainSepHex: hexOf(new TextEncoder().encode(row.domain.padEnd(32, "\0"))),
      artefactManifestSha256: manifestSha256(row.id),
      updatedAt: new Date().toISOString(),
    };
    record.artefactManifestSha256 = manifestSha256(row.id);
    deployment.tokens[row.id] = record;
    return record;
  });
  save();

  for (const record of records) await reconcile(record, publicData, save);

  if (records.every(complete)) {
    log("nothing-to-do", { tokens: records.map((r) => r.id) });
  } else {
    const lock = takeFundingLock("deploy-tokens");
    const { height, parameters } = await fetchLedgerParameters(network);
    log("wallet.open", { ledgerParametersBlock: height });
    const session = await WalletSession.open({
      network,
      mnemonicFile: process.env.FUNDING_WALLET_FILE?.trim() || "/secrets/stagenet",
      dustParameters: parameters.dust,
      feeBlocksMargin: 5,
      syncTimeoutMs: 20 * 60 * 1000,
      log: progress,
    });
    try {
      const balances = await session.balances();
      log("wallet.synced", {
        unshieldedAddress: session.identity.unshieldedAddress,
        dust: balances.dust.toString(),
        night: balances.night.toString(),
      });
      for (const record of records) {
        const id = record.id;
        const providers = tokenProviders(id, network, session, progress);
        const compiledContract = await compiledContractFor(id);

        if (!deployed(record)) {
          // Audit C9: a recorded address whose deployment is not confirmed may still land
          // (a crash during submission can leave "built" after a broadcast); never replace it
          // silently.
          if (record.address && !force) {
            throw new Error(
              `${id}: deployment ${record.address} is recorded as ${record.deployStatus ?? "unknown"} and not confirmed; ` +
                "check the chain, then re-run with --force to build a new deployment",
            );
          }
          const signingKey = sampleSigningKey();
          const verifyingKey = signatureVerifyingKey(signingKey);
          const keyDir = join(stateDir(), "maintenance");
          const pendingKeyFile = join(keyDir, `${id}-pending-${Date.now()}.signing-key.json`);
          writeSecretFile(pendingKeyFile, JSON.stringify(signingKey));
          const started = Date.now();
          log("deploy.build", { token: id });
          const unsubmitted = await createUnprovenDeployTx(providers as never, {
            compiledContract,
            signingKey,
          } as never);
          const address = unsubmitted.public.contractAddress;
          renameSync(pendingKeyFile, join(keyDir, `${id}-${address}.signing-key.json`));
          record.address = address;
          // Audit C10: the key is a tagged object ({ tag, value }); String() gave "[object Object]".
          record.maintenanceVerifyingKey = `${verifyingKey.tag}:${verifyingKey.value}`;
          record.deployStatus = "built";
          record.deploy = undefined;
          record.publishMetadata = undefined;
          record.tokenColor = undefined;
          record.colourChecks = undefined;
          record.updatedAt = new Date().toISOString();
          save();
          log("deploy.address-recorded", { token: id, address });
          const txId = await submitTxAsync(providers as never, { unprovenTx: unsubmitted.private.unprovenTx });
          record.deployStatus = "submitted";
          record.updatedAt = new Date().toISOString();
          save();
          log("deploy.submitted", { token: id, txId, ms: Date.now() - started });
          const data = await withTimeout(publicData.watchForDeployTxData(address), 15 * 60_000, "deploy inclusion");
          record.deploy = txRecord(data);
          record.deployStatus = String(data.status);
          record.updatedAt = new Date().toISOString();
          save();
          log("deploy.done", { token: id, address, ...record.deploy, ms: Date.now() - started });
          if (!deployed(record)) throw new Error(`${id} deploy finished with status ${record.deployStatus}`);
        }

        if (!published(record)) {
          const started = Date.now();
          log("publishMetadata.call", { token: id, address: record.address });
          const result = await withTimeout(
            submitCallTx(providers as never, {
              compiledContract,
              contractAddress: record.address!,
              circuitId: "publishMetadata",
            } as never) as Promise<{ public: FinalizedTxData }>,
            15 * 60_000,
            "publishMetadata inclusion",
          );
          record.publishMetadata = txRecord(result.public);
          record.updatedAt = new Date().toISOString();
          save();
          log("publishMetadata.done", { token: id, ...record.publishMetadata, ms: Date.now() - started });
          if (!published(record)) throw new Error(`${id} publishMetadata finished with status ${record.publishMetadata.status}`);
        }

        if (record.tokenColor === undefined || record.colourChecks?.equal !== true) {
          const call = (await createUnprovenCallTx(providers as never, {
            compiledContract,
            contractAddress: record.address!,
            circuitId: "tokenColor",
          } as never)) as { private: { result: Uint8Array } };
          const row = rows.find((r) => r.id === id)!;
          record.tokenColor = hexOf(call.private.result);
          const byLedger = colourByLedger(row, record.address!);
          const byFormula = colourByFormula(row, record.address!);
          record.colourChecks = {
            rawTokenType: byLedger,
            persistentCommit: byFormula,
            equal: byLedger === record.tokenColor && byFormula === record.tokenColor,
          };
          record.updatedAt = new Date().toISOString();
          save();
          log("colour", { token: id, tokenColor: record.tokenColor, ...record.colourChecks });
        }
      }
      const after = await session.balances();
      log("wallet.after", { dust: after.dust.toString() });
    } finally {
      await session.close().catch(() => undefined);
      lock.release();
    }
  }

  // Final checks from public data only.
  for (const record of records) {
    const module = await loadContractModule(record.id);
    const state = await publicData.queryContractState(record.address!);
    const ledgerState = state ? module.ledger(state.data) : undefined;
    log("verify", {
      token: record.id,
      address: record.address,
      indexerHasState: state !== null,
      published: ledgerState?._published ?? null,
      mints: ledgerState?._mints?.toString() ?? null,
      deployStatus: record.deployStatus,
      publishStatus: record.publishMetadata?.status,
      tokenColor: record.tokenColor,
      colourEqual: record.colourChecks?.equal,
    });
    if (!state || ledgerState?._published !== true || !complete(record)) {
      throw new Error(`${record.id}: verification failed`);
    }
  }
  log("summary", {
    tokens: records.map((r) => ({ id: r.id, address: r.address, tokenColor: r.tokenColor })),
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[deploy-tokens] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
