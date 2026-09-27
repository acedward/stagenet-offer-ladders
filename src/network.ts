/**
 * Network endpoints for the ladder service and its tools (public data only).
 *
 * Defaults are Midnight stagenet (node 2.0.0-d9729c13, ledger-v9 1.0.0-rc.3, `dust/9`).
 * Every endpoint can be overridden from the environment.
 *
 * @module
 */
import { Buffer } from "node:buffer";

import * as ledger from "@midnightntwrk/ledger-v9";

/** Endpoints a wallet session talks to. */
export interface WalletNetwork {
  readonly networkId: string;
  readonly indexerHttpUrl: string;
  readonly indexerWsUrl: string;
  /** Node RPC (http(s)); the submission relay is the same host over ws(s). */
  readonly nodeUrl: string;
  /** Proof server (the wallet proves offers and fee inputs with it). */
  readonly proofServerUrl: string;
}

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

/** Stagenet, with per-endpoint environment overrides. */
export const stagenet = (): WalletNetwork => ({
  networkId: env("MN_NETWORK_ID", "stagenet"),
  indexerHttpUrl: env("MN_INDEXER_URL", "https://indexer.stagenet.shielded.tools/api/v4/graphql"),
  indexerWsUrl: env("MN_INDEXER_WS_URL", "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws"),
  nodeUrl: env("MN_NODE_URL", "https://rpc.stagenet.shielded.tools"),
  proofServerUrl: env("MN_PROOF_SERVER_URL", "http://127.0.0.1:6300"),
});

/** `https://host` → `wss://host`, `http://host` → `ws://host`. */
export const wsUrl = (httpUrl: string): URL => {
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
    signal: AbortSignal.timeout(30_000), // audit C6: no unbounded startup wait
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

/** The node's `system_version` (JSON-RPC over HTTP), with a deadline. */
export const fetchNodeVersion = async (network: WalletNetwork, timeoutMs = 30_000): Promise<string> => {
  const response = await fetch(network.nodeUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_version", params: [] }),
  });
  if (!response.ok) throw new Error(`node system_version: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown };
  if (typeof body.result !== "string") throw new Error("node system_version: no result");
  return body.result;
};
