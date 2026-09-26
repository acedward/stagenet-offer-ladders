/**
 * The stk token set: rows of `tokens/stk.json`, the generated contracts' artefacts, the
 * colour formula, and the deployment record `deployments/stagenet.json`.
 *
 * @module
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CompactTypeBytes, CompactTypeVector, persistentCommit } from "@midnight-ntwrk/compact-runtime";
import { rawTokenType } from "@midnightntwrk/ledger-v9";

export const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
export const TOKENS_FILE = join(REPOSITORY_ROOT, "tokens", "stk.json");
export const DEPLOYMENT_FILE = join(REPOSITORY_ROOT, "deployments", "stagenet.json");

export const TOKEN_IDS = ["stkA", "stkB", "stkC"] as const;
export type TokenId = (typeof TOKEN_IDS)[number];

export interface TokenRow {
  readonly id: TokenId;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly domain: string;
}

export const isTokenId = (value: string): value is TokenId => (TOKEN_IDS as readonly string[]).includes(value);

export const tokenRows = (): TokenRow[] =>
  (JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as { rows: TokenRow[] }).rows;

export const tokenRow = (id: TokenId): TokenRow => {
  const row = tokenRows().find((r) => r.id === id);
  if (!row) throw new Error(`token ${id} is not in tokens/stk.json`);
  return row;
};

/** Directory of a contract's compiler output (`keys/`, `zkir/`, `contract/`, `compiler/`). */
export const managedDirectory = (id: TokenId): string => join(REPOSITORY_ROOT, "contracts", "managed", id);

/** `pad(size, text)` as Compact produces it: UTF-8, NUL-padded on the right. */
export const pad = (size: number, text: string): Uint8Array => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > size) throw new Error(`"${text}" does not fit in ${size} bytes`);
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
};

export const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const bytesOfHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex.replace(/^0x/i, ""), "hex"));

export const domainSeparator = (row: TokenRow): Uint8Array => pad(32, row.domain);

/** Colour with the ledger's own function: `rawTokenType(domainSep, contract)`. */
export const colourByLedger = (row: TokenRow, address: string): string =>
  rawTokenType(domainSeparator(row), address);

/**
 * Colour with the standard library's formula (`tokenType` in Compact):
 * `persistentCommit([domainSep, address], pad(32, "midnight:derive_token"))`, as the
 * reference deploy script derives it.
 */
export const colourByFormula = (row: TokenRow, address: string): string => {
  const bytes32 = new CompactTypeBytes(32);
  return hexOf(
    persistentCommit(
      new CompactTypeVector(2, bytes32),
      [domainSeparator(row), bytesOfHex(address)],
      pad(32, "midnight:derive_token"),
    ),
  );
};

// ---------------------------------------------------------------------------
// deployments/stagenet.json
// ---------------------------------------------------------------------------

export interface TxRecord {
  txId: string;
  txHash: string;
  identifiers?: readonly string[];
  blockHeight: number;
  blockHash?: string;
  blockTimestamp?: string;
  status: string;
  fees?: { paidFees: string; estimatedFees: string };
  at: string;
}

export interface TokenRecord {
  id: TokenId;
  name: string;
  symbol: string;
  decimals: number;
  domain: string;
  domainSepHex: string;
  /** SHA-256 of the contract's `compiler/contract-manifest.json` (lists every artefact). */
  artefactManifestSha256: string;
  /** Contract address; recorded BEFORE the deploy transaction is submitted. */
  address?: string;
  /** Public key of the maintenance authority (the signing key itself stays private). */
  maintenanceVerifyingKey?: string;
  /** `built` → `submitted` → `SucceedEntirely` (or a failure status). */
  deployStatus?: string;
  deploy?: TxRecord;
  publishMetadata?: TxRecord;
  /** Colour from the contract's own `tokenColor()` circuit, run against the on-chain state. */
  tokenColor?: string;
  colourChecks?: { rawTokenType: string; persistentCommit: string; equal: boolean };
  updatedAt: string;
}

export interface Deployment {
  schemaVersion: 1;
  network: { name: string; networkId: string; node: string; indexer: string; nodeVersion?: string };
  source: { contracts: string; compiler: string };
  tokens: Partial<Record<TokenId, TokenRecord>>;
}

export const loadDeployment = (network: Deployment["network"]): Deployment =>
  existsSync(DEPLOYMENT_FILE)
    ? (JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment)
    : {
        schemaVersion: 1,
        network,
        source: {
          contracts:
            "generated from acedward/mip-0018-midnight-contracts @ 7d9f6596d66e3953eb6b14ce152f09169de61eda (SSTAR shape; contracts/README.md)",
          compiler:
            "compactc 0.34.0 (LFDT-Minokawa release, aarch64 linux-musl archive SHA-256 d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d)",
        },
        tokens: {},
      };

export const saveDeployment = (deployment: Deployment): void => {
  const temporary = `${DEPLOYMENT_FILE}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  renameSync(temporary, DEPLOYMENT_FILE);
};

/**
 * `deploy-tokens.ts` arguments (audit F-B22): token ids and flags are parsed separately, so
 * `--force` reaches the override instead of failing as an unknown token.
 */
export const parseDeployArgs = (argv: readonly string[]): { tokens: TokenId[]; force: boolean } => {
  const tokens: TokenId[] = [];
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag "${arg}"`);
    if (!isTokenId(arg)) throw new Error(`unknown token "${arg}"`);
    tokens.push(arg);
  }
  return { tokens, force };
};
