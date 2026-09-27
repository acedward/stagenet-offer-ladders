/**
 * Mint stk test tokens on stagenet with the funding wallet.
 *
 *   bun scripts/mint.ts --token stkA|stkB|stkC --amount <whole tokens> --count <k> --to self|<shielded address>
 *   bun scripts/mint.ts --batch stkA:100x3,stkB:100x3,stkB:1000x1,stkC:1000x1 --to self [--label <name>]
 *   (normally through scripts/stagenet-run.sh, which starts and removes the proof server)
 *
 * - Each coin is one `mint(recipient, amount × 10^6, nonce)` call with a fresh random
 *   32-byte nonce, so every coin is distinct. Mints run one at a time (k=14 proofs).
 * - `--to self` mints to the funding wallet's own coin public key. Any other value must be
 *   a shielded bech32m address (`mn_shield-addr_stagenet1…`); the recipient's encryption
 *   public key is then passed to midnight-js (`additionalCoinEncPublicKeyMappings`), which
 *   otherwise cannot encrypt the output ("Unable to resolve encryption public key…").
 * - Every mint is appended to `out/mints.stagenet.jsonl`: label, token, contract, the call
 *   nonce, the minted coin (nonce, colour, value), the recipient's PUBLIC keys and the
 *   transaction (id, hash, block, status, fees). Never a seed.
 * - `--label` makes a batch resumable: mints already recorded under that label (same token,
 *   amount and recipient, status SucceedEntirely) count towards `--count`, so a re-run only
 *   mints what is missing.
 * - After minting to self it waits until the wallet sees the new coins, then prints each
 *   stk colour's balance and coin count.
 *
 * Prints public data only.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { submitCallTx } from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxData } from "@midnight-ntwrk/midnight-js-types";
import { MidnightBech32m, ShieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

import { compiledContractFor, tokenProviders } from "../src/providers.ts";
import { takeFundingLock } from "../src/state.ts";
import {
  bytesOfHex,
  type Deployment,
  DEPLOYMENT_FILE,
  hexOf,
  isTokenId,
  REPOSITORY_ROOT,
  type TokenId,
} from "../src/tokens.ts";
import { fetchLedgerParameters, stagenet, WalletSession } from "../src/wallet.ts";

const DECIMALS = 6n;
const MINTS_FILE = join(REPOSITORY_ROOT, "out", "mints.stagenet.jsonl");

const log = (event: string, fields: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
const progress = (line: string): void => log("progress", { line });

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

interface Group {
  token: TokenId;
  wholeTokens: bigint;
  count: number;
}

const parseGroups = (): Group[] => {
  const batch = argument("batch");
  const specs = batch
    ? batch.split(",").map((spec) => {
        const match = /^(stk[ABC]):(\d+)x(\d+)$/.exec(spec.trim());
        if (!match) throw new Error(`bad --batch entry "${spec}" (expected stkA:100x3)`);
        return { token: match[1]!, amount: match[2]!, count: match[3]! };
      })
    : [{ token: argument("token") ?? "", amount: argument("amount") ?? "", count: argument("count") ?? "1" }];
  return specs.map(({ token, amount, count }) => {
    if (!isTokenId(token)) throw new Error(`--token must be stkA, stkB or stkC (got "${token}")`);
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("--amount must be a positive whole number");
    const k = Number(count);
    if (!Number.isSafeInteger(k) || k < 1 || k > 100) throw new Error("--count must be 1..100");
    return { token, wholeTokens: BigInt(amount), count: k };
  });
};

interface Recipient {
  kind: "self" | "address";
  shieldedAddress: string;
  coinPublicKey: string;
  encryptionPublicKey: string;
}

const txRecord = (data: FinalizedTxData) => ({
  txId: data.txId,
  txHash: data.txHash,
  blockHeight: Number(data.blockHeight),
  blockHash: data.blockHash,
  status: String(data.status),
  fees: data.fees ? { paidFees: String(data.fees.paidFees), estimatedFees: String(data.fees.estimatedFees) } : undefined,
});

interface MintLine {
  label: string | null;
  token: TokenId;
  amount: string;
  recipient: { coinPublicKey: string };
  tx: { status: string };
}

/** Audit C8: a line per mint written BEFORE it is submitted (call nonce = minted coin nonce). */
const PENDING_FILE = join(REPOSITORY_ROOT, "out", "mints.pending.jsonl");
interface PendingLine {
  label: string | null;
  token: TokenId;
  amount: string;
  callNonce: string;
  recipient: { coinPublicKey: string };
  at: string;
}
/** Audit F-B20: an operator's clearance of a pending mint is recorded durably. */
const CLEARED_FILE = join(REPOSITORY_ROOT, "out", "mints.cleared.jsonl");
/** Append one line and fsync it before continuing (a pending line must be durable before submit). */
const appendDurable = (file: string, line: string): void => {
  mkdirSync(join(REPOSITORY_ROOT, "out"), { recursive: true });
  const fd = openSync(file, "a", 0o644);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    const dir = openSync(join(REPOSITORY_ROOT, "out"), "r"); // the directory entry too (a new file)
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    /* not supported on every filesystem */
  }
};
const clearedNonces = (): Set<string> =>
  new Set(
    existsSync(CLEARED_FILE)
      ? readFileSync(CLEARED_FILE, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => (JSON.parse(line) as { callNonce: string }).callNonce)
      : [],
  );

const pendingMints = (): PendingLine[] =>
  existsSync(PENDING_FILE)
    ? readFileSync(PENDING_FILE, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as PendingLine)
    : [];

const recordedMints = (): MintLine[] =>
  existsSync(MINTS_FILE)
    ? readFileSync(MINTS_FILE, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as MintLine)
    : [];

async function main(): Promise<void> {
  const groups = parseGroups();
  const label = argument("label") ?? null;
  const to = argument("to") ?? "self";
  const network = stagenet();
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  for (const group of groups) {
    const record = deployment.tokens[group.token];
    if (record?.deployStatus !== "SucceedEntirely" || !record.address || !record.tokenColor) {
      throw new Error(`${group.token} is not deployed (deployments/stagenet.json)`);
    }
  }

  const lock = takeFundingLock("mint");
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
    const before = await session.balances();
    // Audit C8: resolve mints that were submitted but never recorded, before minting more.
    {
      const recordedNonces = new Set(recordedMints().map((m) => (m as unknown as { callNonce?: string }).callNonce));
      for (const nonce of (argument("clear-pending") ?? "").split(",").filter(Boolean)) {
        if (!pendingMints().some((p) => p.callNonce === nonce)) throw new Error(`--clear-pending ${nonce.slice(0, 12)}…: no such pending mint`);
        appendDurable(CLEARED_FILE, `${JSON.stringify({ callNonce: nonce, at: new Date().toISOString() })}\n`);
        log("mint.pending-cleared", { callNonce: nonce });
      }
      const cleared = clearedNonces();
      const held = new Set(before.shieldedCoinList.map((c) => c.nonce));
      for (const pending of pendingMints()) {
        if (recordedNonces.has(pending.callNonce) || cleared.has(pending.callNonce)) continue;
        if (pending.recipient.coinPublicKey === session.identity.coinPublicKey && held.has(pending.callNonce)) {
          appendFileSync(
            MINTS_FILE,
            `${JSON.stringify({ ts: new Date().toISOString(), label: pending.label, token: pending.token, amount: pending.amount, callNonce: pending.callNonce, recipient: pending.recipient, tx: { status: "SucceedEntirely" }, reconciled: true })}\n`,
          );
          log("mint.reconciled", { token: pending.token, callNonce: pending.callNonce });
          continue;
        }
        throw new Error(
          `a ${pending.token} mint (call nonce ${pending.callNonce.slice(0, 12)}…) was submitted but never recorded; ` +
            "check the chain, then re-run with --clear-pending <nonce> if it did not land",
        );
      }
    }
    log("wallet.synced", { unshieldedAddress: session.identity.unshieldedAddress, dust: before.dust.toString() });

    let recipient: Recipient;
    if (to === "self") {
      recipient = {
        kind: "self",
        shieldedAddress: session.identity.shieldedAddress,
        coinPublicKey: session.identity.coinPublicKey,
        encryptionPublicKey: session.identity.encryptionPublicKey,
      };
    } else {
      const address = MidnightBech32m.parse(to).decode(ShieldedAddress, network.networkId);
      recipient = {
        kind: "address",
        shieldedAddress: to,
        coinPublicKey: address.coinPublicKeyString(),
        encryptionPublicKey: address.encryptionPublicKeyString(),
      };
    }
    const mappings =
      recipient.kind === "address"
        ? new Map([[recipient.coinPublicKey, recipient.encryptionPublicKey]])
        : undefined;
    const zswapRecipient = {
      is_left: true,
      left: { bytes: bytesOfHex(recipient.coinPublicKey) },
      right: { bytes: new Uint8Array(32) },
    };

    mkdirSync(join(REPOSITORY_ROOT, "out"), { recursive: true });
    const mintedNow: { colour: string; nonce: string }[] = [];
    for (const group of groups) {
      const record = deployment.tokens[group.token]!;
      const amount = group.wholeTokens * 10n ** DECIMALS;
      const done =
        label === null
          ? 0
          : recordedMints().filter(
              (m) =>
                m.label === label &&
                m.token === group.token &&
                m.amount === amount.toString() &&
                m.recipient.coinPublicKey === recipient.coinPublicKey &&
                m.tx.status === "SucceedEntirely",
            ).length;
      const todo = Math.max(0, group.count - done);
      log("group", { token: group.token, wholeTokens: group.wholeTokens.toString(), count: group.count, alreadyRecorded: done, toMint: todo });
      const colour = record.tokenColor!;
      if (todo === 0) continue;
      const providers = tokenProviders(group.token, network, session, progress);
      const compiledContract = await compiledContractFor(group.token);
      for (let i = 0; i < todo; i++) {
        const nonce = new Uint8Array(randomBytes(32));
        appendDurable(
          PENDING_FILE,
          `${JSON.stringify({ label, token: group.token, amount: amount.toString(), callNonce: hexOf(nonce), recipient: { coinPublicKey: recipient.coinPublicKey }, at: new Date().toISOString() } satisfies PendingLine)}\n`,
        );
        const started = Date.now();
        log("mint.call", { token: group.token, amount: amount.toString(), index: done + i + 1, of: group.count });
        const result = (await submitCallTx(providers as never, {
          compiledContract,
          contractAddress: record.address!,
          circuitId: "mint",
          args: [zswapRecipient, amount, nonce],
          ...(mappings ? { additionalCoinEncPublicKeyMappings: mappings } : {}),
        } as never)) as { public: FinalizedTxData; private: { result: { nonce: Uint8Array; color: Uint8Array; value: bigint } } };
        const coin = result.private.result;
        const line = {
          ts: new Date().toISOString(),
          label,
          network: network.networkId,
          token: group.token,
          contract: record.address,
          amount: amount.toString(),
          wholeTokens: group.wholeTokens.toString(),
          callNonce: hexOf(nonce),
          coin: { nonce: hexOf(coin.nonce), colour: hexOf(coin.color), value: coin.value.toString() },
          recipient: {
            kind: recipient.kind,
            shieldedAddress: recipient.shieldedAddress,
            coinPublicKey: recipient.coinPublicKey,
          },
          tx: txRecord(result.public),
          ms: Date.now() - started,
        };
        appendFileSync(MINTS_FILE, `${JSON.stringify(line)}\n`);
        log("mint.done", line);
        if (line.tx.status !== "SucceedEntirely") throw new Error(`mint finished with status ${line.tx.status}`);
        if (line.coin.colour !== colour) throw new Error(`minted colour ${line.coin.colour} != recorded ${colour}`);
        mintedNow.push({ colour, nonce: line.coin.nonce });
      }
    }

    if (recipient.kind === "self" && mintedNow.length > 0) {
      // Wait until the wallet holds every coin minted in this run (matched by coin nonce).
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        const balances = await session.balances();
        const held = new Set(balances.shieldedCoinList.map((c) => `${c.colour}:${c.nonce}`));
        const missing = mintedNow.filter((c) => !held.has(`${c.colour}:${c.nonce}`));
        log("wallet.coins", { mintedThisRun: mintedNow.length, visible: mintedNow.length - missing.length });
        if (missing.length === 0) break;
        if (Date.now() > deadline) throw new Error(`${missing.length} minted coin(s) not visible in the wallet after 10 minutes`);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    // Per-token report (public): balance, coin count and each coin of the stk colours.
    const balances = await session.balances();
    const report = Object.fromEntries(
      groups
        .map((g) => g.token)
        .filter((t, i, all) => all.indexOf(t) === i)
        .map((token) => {
          const colour = deployment.tokens[token]!.tokenColor!;
          const coins = balances.shieldedCoinList.filter((c) => c.colour === colour);
          return [
            token,
            {
              colour,
              balance: (balances.shielded[colour] ?? 0n).toString(),
              coinCount: coins.length,
              coins: coins.map((c) => ({ nonce: c.nonce, value: c.value.toString() })),
            },
          ];
        }),
    );
    log("balances", { recipient: recipient.kind, report, dust: balances.dust.toString() });
  } finally {
    await session.close().catch(() => undefined);
    lock.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[mint] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
