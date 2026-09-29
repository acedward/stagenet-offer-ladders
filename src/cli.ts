/**
 * Command-line entry point of the ladder service and its maker tooling.
 *
 *   bun src/cli.ts <command> [--flag value …]
 *
 * Commands print progress on stderr and one JSON result on stdout. Nothing secret is
 * ever printed: mnemonics stay in the mode-600 secrets file and in memory.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { MidnightBech32m, ShieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

import { buildPublicMakers, checkMakers, type PublicMakersFile, renderPublicMakersMarkdown } from "./addresses.ts";
import { fundMakers, type FundingPorts, loadFundingRecords, planFunding, serializeFundingRecords, type TransferRecord } from "./funding.ts";
import { openFunderOps } from "./funding-ops.ts";
import { readLadderFile } from "./ladder.ts";
import { fetchLedgerParameters, fetchNodeVersion, stagenet } from "./network.ts";
import { inspectOffer } from "./offer-inspect.ts";
import { openJournal, writeAtomic } from "./journal.ts";
import { Outbox } from "./outbox.ts";
import { createService, fundingLock, loadServiceConfig } from "./service.ts";
import { takeServiceLock } from "./service-lock.ts";
import { startWatchdog } from "./watchdog.ts";
import { openMakerOps } from "./maker-ops.ts";
import { balanceRow, loadMintRecords, type MintRecord, mintAll, registerDustAll, serializeMintRecords } from "./makers.ts";
import { redact, redactDeep } from "./redact.ts";
import { dryRunSettlement, settleOffer } from "./settle.ts";
import type { TokenId } from "./tokens.ts";
import { lookupTransaction } from "./tx-lookup.ts";
import { verifyCurrentOffers } from "./verify.ts";
import { WalletSession } from "./wallet-session.ts";
import {
  addMakersToFile,
  defaultMakersFile,
  generateMakers,
  identityOf,
  planMakerSlots,
  readMakersFile,
  readMnemonicFile,
  writeMakersFileExclusive,
} from "./wallets.ts";

// ---------------------------------------------------------------------------
// Arguments and output
// ---------------------------------------------------------------------------

export type Flags = Readonly<Record<string, string | true>>;

export const parseFlags = (argv: readonly string[]): Flags => {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return flags;
};

const flag = (flags: Flags, name: string, fallback?: string): string | undefined => {
  const value = flags[name];
  if (value === true) throw new Error(`--${name} needs a value`);
  return value ?? fallback;
};

/** Every log line and every JSON result pass through `redact` (audit F-B23 / F-A22). */
export const log = (line: string): void => {
  console.error(`[${new Date().toISOString()}] ${redact(line)}`);
};

const jsonReplacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);
export const printResult = (result: unknown): void => {
  // Strings are redacted before serialisation (escapes would hide them), then the text again.
  const safe = redactDeep(JSON.parse(JSON.stringify(result, jsonReplacer)));
  console.log(redact(JSON.stringify(safe, null, 2)));
};

/** Write a public (non-secret) file atomically, creating its directory. */
const writePublicFile = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, contents, { mode: 0o644 });
  renameSync(temp, path);
};

const DEFAULT_LADDER_FILE = "ladders/stagenet.json";

/** The shared state directory (journal, outbox, service.lock): helper and Compose use the same one. */
const stateDirectory = (): string =>
  process.env["STATE_DIR"]?.trim() || `${process.env["HOME"] ?? "/root"}/.stagenet-offer-ladders/state`;

/** Audit C4: every wallet-opening command holds the per-state-directory service lock. */
const withServiceLock = async <T>(command: string, fn: () => Promise<T>): Promise<T> => {
  const lock = takeServiceLock(stateDirectory(), command);
  try {
    return await fn();
  } finally {
    lock.release();
  }
};
const DEFAULT_PUBLIC_JSON = "ladders/makers.stagenet.public.json";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Command = (flags: Flags) => Promise<number>;

/** wallets:generate --count 20 --ladders AB,BC [--network stagenet] [--makers-file path] */
const walletsGenerate: Command = async (flags) => {
  const makersFile = resolve(flag(flags, "makers-file", defaultMakersFile())!);
  const count = Number(flag(flags, "count", "20"));
  const ladders = flag(flags, "ladders", "AB,BC")!.split(",").map((s) => s.trim()).filter(Boolean);
  const networkId = flag(flags, "network", stagenet().networkId)!;
  if (existsSync(makersFile)) {
    log(`refusing: ${makersFile} already exists (maker wallets are never overwritten)`);
    return 3;
  }
  const plan = planMakerSlots(count, ladders);
  const data = generateMakers(networkId, plan);
  writeMakersFileExclusive(makersFile, data);
  log(`wrote ${data.makers.length} maker wallets to ${makersFile} (mode 600, directory 700)`);
  printResult({
    makersFile,
    networkId,
    count: data.makers.length,
    slots: data.makers.map((maker) => ({
      slot: maker.slot,
      unshieldedAddress: identityOf(maker.mnemonic, networkId).unshieldedAddress,
    })),
  });
  return 0;
};

/**
 * wallets:add --ladders T13,T26,T52 --count 9 [--makers-file path] [--network stagenet]
 *
 * (00058 FR-006) Append `count / ladders` fresh maker wallets per ladder (`T13-01` …) to the
 * EXISTING secrets file: refuses a missing file, a network mismatch and any id that already
 * exists; writes `<file>.bak-<UTC stamp>` (600) first, then replaces the file atomically with
 * every existing entry byte-identical. Prints wallet ids, unshielded addresses, counts and
 * sha256s only (never a mnemonic). Then run wallets:check and wallets:addresses.
 */
const walletsAdd: Command = async (flags) => {
  const makersFile = resolve(flag(flags, "makers-file", defaultMakersFile())!);
  const laddersFlag = flag(flags, "ladders");
  const countFlag = flag(flags, "count");
  if (laddersFlag === undefined || countFlag === undefined) throw new Error("--ladders and --count are required (e.g. --ladders T13,T26,T52 --count 9)");
  const ladders = laddersFlag.split(",").map((s) => s.trim()).filter(Boolean);
  const networkId = flag(flags, "network", stagenet().networkId)!;
  const plan = planMakerSlots(Number(countFlag), ladders);
  const result = addMakersToFile(makersFile, { networkId, plan });
  log(`added ${result.added.length} maker wallets to ${makersFile} (${result.before.entries} → ${result.after.entries}; backup ${result.backupFile})`);
  printResult({
    makersFile: result.makersFile,
    backupFile: result.backupFile,
    networkId: result.networkId,
    before: result.before,
    after: result.after,
    preservedPrefix: result.preserved,
    added: result.added.map((maker) => ({ slot: maker.slot, unshieldedAddress: maker.unshieldedAddress })),
  });
  return 0;
};

/** wallets:addresses [--ladder-file f] [--public-json f] [--public-md f] */
const walletsAddresses: Command = async (flags) => {
  const makers = readMakersFile(resolve(flag(flags, "makers-file", defaultMakersFile())!));
  const ladderFile = flag(flags, "ladder-file", DEFAULT_LADDER_FILE)!;
  const ladders = existsSync(ladderFile) ? readLadderFile(ladderFile) : undefined;
  const published = buildPublicMakers(makers, ladders);
  const jsonPath = flag(flags, "public-json", DEFAULT_PUBLIC_JSON)!;
  writePublicFile(jsonPath, `${JSON.stringify(published, null, 2)}\n`);
  log(`wrote ${jsonPath}`);
  const mdPath = flag(flags, "public-md");
  if (mdPath !== undefined) {
    writePublicFile(mdPath, renderPublicMakersMarkdown(published, `Repository copy: \`${DEFAULT_PUBLIC_JSON}\`.`));
    log(`wrote ${mdPath}`);
  }
  printResult({
    networkId: published.networkId,
    makers: published.makers.map((m) => ({ slot: m.slot, price: m.price, unshieldedAddress: m.unshieldedAddress })),
  });
  return 0;
};

/** wallets:check [--public-json f]: re-derive, parse, distinctness, public-file match. */
const walletsCheck: Command = async (flags) => {
  const makers = readMakersFile(resolve(flag(flags, "makers-file", defaultMakersFile())!));
  const jsonPath = flag(flags, "public-json", DEFAULT_PUBLIC_JSON)!;
  const published = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, "utf8")) as PublicMakersFile) : undefined;
  const result = checkMakers(makers, published);
  const pass = result.problems.length === 0 && (published === undefined || result.matchesPublicFile === true);
  printResult({ result: pass ? "PASS" : "FAIL", networkId: makers.networkId, ...result });
  return pass ? 0 : 1;
};

/**
 * makers:status --slots AB-01,BC-01 [--stagger-ms 2000]: sync makers ONE AT A TIME. Per maker:
 * addresses (and whether the SDK agrees), NIGHT with each UTxO's DUST-registration flag, DUST,
 * shielded balances per colour (`balanceRow`).
 */
const makersStatus: Command = async (flags) => {
  const makers = readMakersFile(resolve(flag(flags, "makers-file", defaultMakersFile())!));
  const wanted = flag(flags, "slots", "all")!;
  const selected =
    wanted === "all" ? makers.makers : makers.makers.filter((m) => wanted.split(",").map((s) => s.trim()).includes(m.slot));
  if (selected.length === 0) throw new Error(`no maker matches --slots ${wanted}`);
  const stagger = Number(flag(flags, "stagger-ms", "2000"));
  const network = stagenet();
  if (network.networkId !== makers.networkId) throw new Error(`makers file is for ${makers.networkId}, network is ${network.networkId}`);
  const { height, parameters } = await fetchLedgerParameters(network);
  log(`ledger parameters from block ${height}`);
  const rows = [];
  for (const [index, maker] of selected.entries()) {
    if (index > 0 && stagger > 0) await new Promise((r) => setTimeout(r, stagger));
    const started = Date.now();
    const session = await WalletSession.open({
      network,
      mnemonic: maker.mnemonic,
      dustParameters: parameters.dust,
      syncTimeoutMs: Number(flag(flags, "sync-timeout-ms", String(20 * 60 * 1000))),
      log: (line) => log(`${maker.slot}: ${line}`),
    });
    try {
      const state = await session.synced();
      const balances = WalletSession.balancesOf(state);
      // What the running SDK sees, encoded with the same codecs as the public file.
      const sdk = {
        unshieldedAddress: MidnightBech32m.encode(makers.networkId, state.unshielded.address).asString(),
        shieldedAddress: MidnightBech32m.encode(makers.networkId, state.shielded.address).asString(),
        dustAddress: MidnightBech32m.encode(makers.networkId, state.dust.address).asString(),
      };
      const expected = identityOf(maker.mnemonic, makers.networkId);
      rows.push({
        slot: maker.slot,
        syncSeconds: Math.round((Date.now() - started) / 1000),
        unshieldedAddress: expected.unshieldedAddress,
        shieldedAddress: expected.shieldedAddress,
        dustAddress: expected.dustAddress,
        sdkAgrees: {
          unshielded: sdk.unshieldedAddress === expected.unshieldedAddress,
          shielded: sdk.shieldedAddress === expected.shieldedAddress,
          dust: sdk.dustAddress === expected.dustAddress,
        },
        ...balanceRow(balances),
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  }
  printResult({ networkId: makers.networkId, ledgerParametersBlock: height, makers: rows });
  return 0;
};

/** ladder:once [--ladder-file f] [--zswap-api url]: one reconcile tick, then exit. */
const ladderOnce: Command = async (flags) => {
  const overrides: { ladderFile?: string; zswapApi?: string } = {};
  const ladderFile = flag(flags, "ladder-file");
  if (ladderFile !== undefined) overrides.ladderFile = ladderFile;
  const zswapApi = flag(flags, "zswap-api");
  if (zswapApi !== undefined) overrides.zswapApi = zswapApi;
  const config = loadServiceConfig(overrides);
  log(`ladder:once mode=${config.mode} delivery=${config.zswapApi ? "kernel" : "outbox"} slots=${config.slots.length} journal=${config.journalFile}`);
  const service = await createService(config, log);
  try {
    const report = await service.scheduler.runTick();
    // Q5 evidence: in THIS process, after the build + release, is every pinned coin of a
    // current offer still spendable (i.e. the wallet no longer holds it as a pending spend)?
    const release: { slot: string; coin: string; spendable: boolean }[] = [];
    for (const record of service.journal.slots()) {
      if (!record.current) continue;
      const wallet = await service.wallets.get(record.walletId);
      const snapshot = await wallet.snapshot();
      release.push({
        slot: record.slot,
        coin: record.current.coinNonce,
        spendable: snapshot.spendable.some((coin) => coin.nonce === record.current!.coinNonce),
      });
    }
    printResult({
      report,
      states: service.journal.summary().byState,
      releaseCheck: { checked: release.length, stillSpendable: release.filter((r) => r.spendable).length, slots: release },
    });
    return report.errors > 0 ? 1 : 0;
  } finally {
    await service.close();
  }
};

/** offers:verify [--ladder-file f] [--test-coins deployments/test-coins.stagenet.json]: offline check of current offers. */
const offersVerify: Command = async (flags) => {
  const overrides: { ladderFile?: string } = {};
  const ladderFile = flag(flags, "ladder-file");
  if (ladderFile !== undefined) overrides.ladderFile = ladderFile;
  const config = loadServiceConfig(overrides);
  const journal = openJournal({ file: config.journalFile, networkId: config.ladders.networkId, mode: config.mode });
  const outbox = new Outbox(config.outboxDir);
  const pool = config.ladders.includeNonces ? new Set(config.ladders.includeNonces) : undefined;
  const reserves = new Set(config.ladders.excludeNonces ?? []);
  const tokenDecimals = Object.fromEntries(Object.entries(config.ladders.tokens).map(([symbol, token]) => [symbol, token.decimals]));
  const result = verifyCurrentOffers(journal, outbox, { ...(pool ? { pool } : {}), reserves, slots: config.slots, tokenDecimals });
  printResult({ result: result.pass ? "PASS" : "FAIL", ...result });
  return result.pass ? 0 : 1;
};

/** A bare switch (`--dry-run`); a value after it is refused rather than guessed at. */
export const switchFlag = (flags: Flags, name: string): boolean => {
  const value = flags[name];
  if (value === undefined) return false;
  if (value !== true) throw new Error(`--${name} takes no value (got ${JSON.stringify(value)})`);
  return true;
};

/** The parsed arguments of `offers:settle` (exported for tests). */
export const settleArgs = (flags: Flags): { slot: string; payWith: string; dryRun: boolean; offerId?: string; ladderFile?: string } => {
  const slot = flag(flags, "slot");
  const payWith = flag(flags, "pay-with");
  if (slot === undefined || payWith === undefined || !/^[0-9a-f]{64}$/u.test(payWith)) {
    throw new Error("--slot and --pay-with <64-hex coin nonce> are required");
  }
  const offerId = flag(flags, "offer-id");
  const ladderFile = flag(flags, "ladder-file");
  return { slot, payWith, dryRun: switchFlag(flags, "dry-run"), ...(offerId === undefined ? {} : { offerId }), ...(ladderFile === undefined ? {} : { ladderFile }) };
};

/**
 * offers:settle --slot AB-02 --pay-with <coin nonce> [--ladder-file f] [--offer-id id] [--dry-run]:
 * settle a slot's current offer on chain as a taker, with the FUNDING wallet, paying with
 * the named (pinned) coin of the want colour. With `--dry-run` (00058 FR-007) the settlement
 * is balanced, proven and finalized, its fee and size reported, and it is NOT submitted.
 */
const offersSettle: Command = async (flags) => {
  const { slot, payWith, dryRun, offerId: offerIdFlag, ladderFile } = settleArgs(flags);
  const config = loadServiceConfig(ladderFile === undefined ? {} : { ladderFile });
  const journal = openJournal({ file: config.journalFile, networkId: config.ladders.networkId, mode: config.mode });
  const record = journal.get(slot);
  if (record === undefined) throw new Error(`no slot ${slot} in the journal`);
  const offerId = offerIdFlag ?? record.current?.offerId;
  if (offerId === undefined) throw new Error(`slot ${slot} has no current offer (state ${record.state})`);
  const entry = new Outbox(config.outboxDir).get(offerId);
  if (entry === undefined) throw new Error(`outbox has no offer ${offerId}`);
  const lock = fundingLock(dryRun ? "00058 offers:settle --dry-run" : "00053 offers:settle");
  try {
    const { height, parameters } = await fetchLedgerParameters(config.network);
    log(`ledger parameters from block ${height}`);
    const session = await WalletSession.open({
      network: config.network,
      mnemonic: readMnemonicFile(config.fundingWalletFile),
      dustParameters: parameters.dust,
      syncTimeoutMs: 20 * 60 * 1000,
      log: (line) => log(`taker: ${line}`),
    });
    try {
      const before = await session.synced();
      const spendableBefore = WalletSession.spendableCoins(before);
      const pinnedBefore = spendableBefore.some((c) => c.nonce === entry.coinNonce);
      const payCoin = spendableBefore.find((c) => c.nonce === payWith);
      if (payCoin === undefined || payCoin.type !== entry.wantColour) {
        throw new Error(`--pay-with ${payWith.slice(0, 12)}… is not a spendable coin of the offer's want colour`);
      }
      log(`offer's pinned coin spendable before settlement: ${pinnedBefore}; paying with ${payCoin.value} base units`);
      if (dryRun) {
        const dry = await dryRunSettlement({
          session,
          blob: entry.blob,
          payColour: entry.wantColour,
          payWithNonce: payWith,
          feeParameters: parameters,
          log,
        });
        printResult({
          slot,
          offerId,
          offerCoin: entry.coinNonce,
          gives: { colour: entry.giveColour, amount: entry.giveAmount },
          wants: { colour: entry.wantColour, amount: entry.wantAmount },
          paidWith: { nonce: payWith, value: payCoin.value },
          takerDust: WalletSession.balancesOf(before).dust,
          settlement: dry,
        });
        return 0;
      }
      const result = await settleOffer({
        session,
        network: config.network,
        blob: entry.blob,
        payColour: entry.wantColour,
        payWithNonce: payWith,
        log,
      });
      log(`settlement ${result.status} in block ${result.blockHeight}; waiting for the wallet to see it`);
      // Let the wallet apply the settlement, then report the coins that changed.
      let after = await session.caughtUp(120_000);
      for (let i = 0; i < 24 && WalletSession.ownedNonces(after).has(entry.coinNonce); i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        after = await session.caughtUp(120_000);
      }
      const owned = WalletSession.ownedNonces(after);
      const beforeNonces = new Set(spendableBefore.map((c) => c.nonce));
      const received = WalletSession.spendableCoins(after).filter((c) => !beforeNonces.has(c.nonce));
      printResult({
        slot,
        offerId,
        offerCoin: entry.coinNonce,
        offerCoinSpendableBeforeSettlement: pinnedBefore,
        paidWith: { nonce: payWith, value: payCoin.value },
        settlement: result,
        afterSettlement: {
          offerCoinStillOwned: owned.has(entry.coinNonce),
          payCoinStillOwned: owned.has(payWith),
          newCoins: received.map((c) => ({ nonce: c.nonce, colour: c.type, value: c.value })),
        },
      });
      return result.status === "SucceedEntirely" ? 0 : 1;
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    lock.release();
  }
};

/** funding:status: read-only balances of the funding wallet (takes funding.lock). */
const fundingStatus: Command = async () => {
  const config = stagenet();
  const lock = fundingLock("00053 funding:status");
  try {
    const { height, parameters } = await fetchLedgerParameters(config);
    const session = await WalletSession.open({
      network: config,
      mnemonic: readMnemonicFile(process.env["FUNDING_WALLET_FILE"]?.trim() || "/secrets/stagenet"),
      dustParameters: parameters.dust,
      syncTimeoutMs: 20 * 60 * 1000,
      log: (line) => log(`funding: ${line}`),
    });
    try {
      const state = await session.synced();
      const balances = WalletSession.balancesOf(state);
      printResult({
        ledgerParametersBlock: height,
        unshieldedAddress: session.identity.unshieldedAddress,
        night: balances.night,
        dust: balances.dust,
        shielded: Object.fromEntries(
          Object.entries(balances.shielded).map(([colour, value]) => [colour, { value, coins: balances.shieldedCoins[colour] ?? 0 }]),
        ),
        coins: WalletSession.spendableCoins(state).map((c) => ({ nonce: c.nonce, colour: c.type, value: c.value })),
      });
      return 0;
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    lock.release();
  }
};



/** ladder:run: the long-running service (SIGINT/SIGTERM stop it after the current slot). */
const ladderRun: Command = async (flags) => {
  const overrides: { ladderFile?: string; zswapApi?: string } = {};
  const ladderFile = flag(flags, "ladder-file");
  if (ladderFile !== undefined) overrides.ladderFile = ladderFile;
  const zswapApi = flag(flags, "zswap-api");
  if (zswapApi !== undefined) overrides.zswapApi = zswapApi;
  const config = loadServiceConfig(overrides);
  log(
    `ladder:run mode=${config.mode} delivery=${config.zswapApi ? "kernel" : "outbox"} slots=${config.slots.length} ` +
      `ttl=${config.scheduler.offerTtlMs / 60_000}min reconcile=${config.reconcileMs / 1000}s journal=${config.journalFile}`,
  );
  const service = await createService(config, log);
  const controller = new AbortController();
  const stop = (signal: string) => {
    if (controller.signal.aborted) return;
    log(`${signal}: stopping after the current slot`);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  // Audit C6: exit when no progress is made, so the restart policy recovers the process.
  const watchdog = startWatchdog({
    lastProgress: () => service.scheduler.lastProgressAt,
    startedAt: Date.now(),
    limitMs: config.watchdogMs,
    onStall: (idleMs) => {
      log(`fatal: no scheduler progress for ${Math.round(idleMs / 1000)} s (watchdog ${config.watchdogMs / 1000} s); exiting`);
      process.exit(70);
    },
  });
  try {
    await service.scheduler.loop(config.reconcileMs, controller.signal);
  } finally {
    watchdog.stop();
    await service.close();
  }
  return 0;
};

/** offers:inspect --offer-id <hex> [--outbox-dir d] | --file <outbox entry json>: decode one offer. */
const offersInspect: Command = async (flags) => {
  const file = flag(flags, "file");
  let blob: string;
  let entry: unknown = null;
  if (file !== undefined) {
    entry = JSON.parse(readFileSync(file, "utf8"));
    blob = (entry as { blob: string }).blob;
  } else {
    const offerId = flag(flags, "offer-id");
    if (offerId === undefined) throw new Error("--offer-id or --file is required");
    const dir = flag(flags, "outbox-dir", process.env["OUTBOX_DIR"] ?? `${process.env["HOME"]}/.stagenet-offer-ladders/state/outbox`)!;
    entry = JSON.parse(readFileSync(`${dir}/${offerId}.json`, "utf8"));
    blob = (entry as { blob: string }).blob;
  }
  const inspection = inspectOffer(blob);
  const { blob: _omit, ...meta } = entry as Record<string, unknown>;
  printResult({ inspection, entry: meta });
  return 0;
};

/** Makers selected by --slots (default all), in secrets-file order. */
const selectMakers = (flags: Flags) => {
  const makers = readMakersFile(resolve(flag(flags, "makers-file", defaultMakersFile())!));
  const wanted = flag(flags, "slots", "all")!;
  const list = wanted.split(",").map((s) => s.trim());
  const selected = wanted === "all" ? makers.makers : makers.makers.filter((m) => list.includes(m.slot));
  if (selected.length === 0) throw new Error(`no maker matches --slots ${wanted}`);
  return { makers, selected };
};

/** Per ladder: give token symbol, colour, contract address and give amount (base units). */
const giveTokenOf = (ladder: string, ladderFile?: string) => {
  const config = loadServiceConfig(ladderFile === undefined ? {} : { ladderFile });
  const def = config.ladders.ladders.find((l) => l.id === ladder);
  if (def === undefined) throw new Error(`ladder ${ladder} is not in ${config.ladderFile}`);
  const slot = config.slots.find((s) => s.ladder === ladder)!;
  const deployment = JSON.parse(readFileSync(process.env["TOKENS_FILE"]?.trim() || "deployments/stagenet.json", "utf8")) as {
    tokens: Record<string, { address?: string; tokenColor?: string; deployStatus?: string }>;
  };
  const record = deployment.tokens[def.give];
  if (!record?.address || record.deployStatus !== "SucceedEntirely") throw new Error(`${def.give} is not deployed (deployments/stagenet.json)`);
  if (record.tokenColor !== slot.giveColour) throw new Error(`${def.give}: deployment colour differs from the ladder colour`);
  return { symbol: def.give as TokenId, colour: slot.giveColour, contractAddress: record.address, giveAmount: BigInt(slot.giveAmount), network: config.network };
};

/** Audit C12: refuse to touch makers when the node is not the pinned version. */
const requirePinnedNode = async (): Promise<void> => {
  const expected = process.env["EXPECTED_NODE_VERSION"] ?? "2.0.0-d9729c13";
  if (expected === "") return;
  const actual = await fetchNodeVersion(stagenet());
  if (actual !== expected) throw new Error(`node version ${actual} != pinned ${expected}; the SDK set must move with it`);
};

/** makers:register-dust [--slots all|AB-01,…] [--stagger-ms 5000]: register makers' NIGHT for DUST (one at a time). */
const makersRegisterDust: Command = async (flags) => {
  const { makers, selected } = selectMakers(flags);
  const network = stagenet();
  if (network.networkId !== makers.networkId) throw new Error(`makers file is for ${makers.networkId}`);
  const { height, parameters } = await fetchLedgerParameters(network);
  log(`ledger parameters from block ${height}; ${selected.length} maker(s)`);
  const byLadder = new Map<string, ReturnType<typeof giveTokenOf>>();
  const results = await registerDustAll(
    selected,
    async (maker) => {
      const give = byLadder.get(maker.ladder) ?? giveTokenOf(maker.ladder, flag(flags, "ladder-file"));
      byLadder.set(maker.ladder, give);
      const secret = selected.find((m) => m.slot === maker.slot)!;
      return await openMakerOps({
        network,
        dustParameters: parameters.dust,
        mnemonic: secret.mnemonic,
        giveToken: give.symbol,
        giveColour: give.colour,
        contractAddress: give.contractAddress,
        log: (line) => log(`${maker.slot}: ${line}`),
      });
    },
    { staggerMs: Number(flag(flags, "stagger-ms", "5000")), log },
  );
  printResult({ networkId: makers.networkId, results });
  return results.some((r) => r.action === "error") ? 1 : 0;
};

/**
 * makers:mint [--slots …] [--inventory-offers 10] [--min-dust 1]: each maker self-mints its
 * give token (AB → stkA, BC → stkB) as ONE coin of inventory-offers × give. Successful
 * mints are recorded in $STATE_DIR/maker-mints.json (public) and never repeated.
 */
const makersMint: Command = async (flags) => {
  const { makers, selected } = selectMakers(flags);
  const network = stagenet();
  if (network.networkId !== makers.networkId) throw new Error(`makers file is for ${makers.networkId}`);
  const inventoryOffers = BigInt(flag(flags, "inventory-offers", process.env["INVENTORY_OFFERS"] ?? "10")!);
  const minDust = BigInt(Math.round(Number(flag(flags, "min-dust", "1")) * 1e6)) * 10n ** 9n; // DUST → SPECK
  const recordFile = `${stateDirectory()}/maker-mints.json`;
  const present = existsSync(recordFile);
  const loaded = loadMintRecords(present ? JSON.parse(readFileSync(recordFile, "utf8")) : undefined, present);
  const record: Record<string, MintRecord> = loaded.records;
  const persist = (): void => {
    mkdirSync(dirname(recordFile), { recursive: true });
    writeAtomic(recordFile, serializeMintRecords(record)); // durable before the next step (audit C8)
  };
  if (loaded.migrated) {
    persist(); // audit F-B17: legacy receipts become `minted` durably BEFORE any wallet opens
    log(`migrated ${recordFile} to version 2 (${Object.keys(record).length} record(s))`);
  }
  const clear = flag(flags, "clear-pending");
  if (clear !== undefined) {
    if (record[clear]?.status !== "pending") throw new Error(`${clear} has no pending mint`);
    log(`clearing ${clear}'s pending mint (nonce ${record[clear]!.nonce.slice(0, 12)}…): only after looking up the mint transaction on the indexer and finding none`);
    delete record[clear];
    persist();
  }
  const { height, parameters } = await fetchLedgerParameters(network);
  log(`ledger parameters from block ${height}; ${selected.length} maker(s); inventory ${inventoryOffers} offers per maker`);
  const results = [];
  for (const ladder of [...new Set(selected.map((m) => m.ladder))]) {
    const give = giveTokenOf(ladder, flag(flags, "ladder-file"));
    const target = inventoryOffers * give.giveAmount;
    const group = selected.filter((m) => m.ladder === ladder);
    results.push(
      ...(await mintAll(
        group,
        async (maker) =>
          await openMakerOps({
            network,
            dustParameters: parameters.dust,
            mnemonic: group.find((m) => m.slot === maker.slot)!.mnemonic,
            giveToken: give.symbol,
            giveColour: give.colour,
            contractAddress: give.contractAddress,
            log: (line) => log(`${maker.slot}: ${line}`),
          }),
        target,
        minDust,
        {
          staggerMs: Number(flag(flags, "stagger-ms", "5000")),
          log,
          records: record,
          onRecord: (slot, entry) => {
            record[slot] = { ...entry, token: give.symbol };
            persist();
          },
        },
      )),
    );
  }
  printResult({ networkId: makers.networkId, results });
  return results.some((r) => ["error", "mint-failed", "skip-pending-unresolved", "skip-no-dust"].includes(r.action)) ? 1 : 0;
};

/**
 * makers:fund [--ladder-file f] [--public-json ladders/makers.stagenet.public.json] [--dry-run]
 *   [--batch-size 5] [--slots AASK-01,…] [--check-balances] [--clear-pending <wallet id>]
 *
 * (00057 FR-003) Send each book maker its give inventory (`inventoryTokens` of its ladder)
 * from the FUNDING wallet by shielded transfer, batched per colour. Recipients' shielded
 * addresses come from the public makers file; no maker secret is read, so it can run next
 * to the service. Records (public) in $STATE_DIR/maker-funding.json make it idempotent:
 * `sent` makers are skipped, `pending` ones are resolved on the indexer and never re-sent
 * blindly. `--dry-run` opens no wallet. `--check-balances` also syncs each recipient (one at
 * a time, under service.lock: the service must be stopped) and skips makers that already
 * hold their inventory. Holds funding.lock; fee margin 5; prints public data only.
 */
const makersFund: Command = async (flags) => {
  const ladderFile = flag(flags, "ladder-file");
  const config = loadServiceConfig(ladderFile === undefined ? {} : { ladderFile });
  if (config.mode !== "wallet-per-slot") throw new Error("makers:fund funds maker wallets: the ladder file must be in wallet-per-slot mode");
  const dryRun = flags["dry-run"] === true;
  const batchSize = Number(flag(flags, "batch-size", "5"));
  const publicPath = flag(flags, "public-json", DEFAULT_PUBLIC_JSON)!;
  const published = JSON.parse(readFileSync(publicPath, "utf8")) as PublicMakersFile;
  if (published.networkId !== config.network.networkId) throw new Error(`${publicPath} is for ${published.networkId}, the network is ${config.network.networkId}`);
  const addresses = new Map(published.makers.map((m) => [m.slot, m.shieldedAddress]));
  const wanted = flag(flags, "slots");
  const slots = wanted === undefined ? config.slots : config.slots.filter((s) => wanted.split(",").map((w) => w.trim()).includes(s.slot));
  if (slots.length === 0) throw new Error(`no slot matches --slots ${wanted}`);
  const targets = planFunding(slots, config.ladders, (walletId) => {
    const address = addresses.get(walletId);
    // Every recipient address must be a shielded address of THIS network before anything moves.
    if (address !== undefined) MidnightBech32m.parse(address).decode(ShieldedAddress, config.network.networkId);
    return address;
  });
  if (targets.length === 0) throw new Error(`no ladder in ${config.ladderFile} names inventoryTokens`);

  const recordFile = `${stateDirectory()}/maker-funding.json`;
  const present = existsSync(recordFile);
  const records: Record<string, TransferRecord> = loadFundingRecords(present ? JSON.parse(readFileSync(recordFile, "utf8")) : undefined, present, config.network.networkId);
  const persist = (): void => {
    mkdirSync(dirname(recordFile), { recursive: true });
    writeAtomic(recordFile, serializeFundingRecords(records, config.network.networkId)); // durable before the next step
  };
  const clear = flag(flags, "clear-pending");
  if (clear !== undefined) {
    const keys = Object.keys(records).filter((k) => records[k]!.walletId === clear && records[k]!.status === "pending");
    if (keys.length === 0) throw new Error(`${clear} has no pending transfer`);
    log(`clearing ${clear}'s pending transfer(s) ${keys.map((k) => records[k]!.txId.slice(0, 16)).join(", ")}…: only after finding no such transaction on the indexer`);
    for (const k of keys) delete records[k];
    persist();
  }
  const run = async (): Promise<number> => {
    const ports: FundingPorts = {
      lookup: (identifier) => lookupTransaction(config.network.indexerHttpUrl, { identifier }),
      openFunder: async () => {
        const { height, parameters } = await fetchLedgerParameters(config.network);
        log(`ledger parameters from block ${height}; opening the funding wallet`);
        return await openFunderOps({
          network: config.network,
          dustParameters: parameters.dust,
          mnemonic: readMnemonicFile(config.fundingWalletFile),
          log: (line) => log(`funder: ${line}`),
        });
      },
    };
    if (flags["check-balances"] === true) {
      const makers = readMakersFile(resolve(flag(flags, "makers-file", config.makersFile)!));
      const { parameters } = await fetchLedgerParameters(config.network);
      ports.makerBalance = async (walletId, colour) => {
        const maker = makers.makers.find((m) => m.slot === walletId);
        if (maker === undefined) throw new Error(`no maker wallet ${walletId} in the secrets file`);
        const session = await WalletSession.open({
          network: config.network,
          mnemonic: maker.mnemonic,
          dustParameters: parameters.dust,
          syncTimeoutMs: 20 * 60 * 1000,
          log: (line) => log(`${walletId}: ${line}`),
        });
        try {
          const state = await session.synced();
          return WalletSession.spendableCoins(state).filter((c) => c.type === colour).reduce((sum, c) => sum + c.value, 0n);
        } finally {
          await session.close().catch(() => undefined);
        }
      };
    }
    const report = await fundMakers(targets, ports, {
      batchSize,
      dryRun,
      records,
      onRecord: (key, record) => {
        records[key] = record;
        persist();
      },
      log,
    });
    printResult({ networkId: config.network.networkId, ladderFile: config.ladderFile, recordFile, ...report });
    return report.results.some((r) => ["error", "not-sent", "skip-pending-unresolved"].includes(r.action)) ? 1 : 0;
  };
  const withMakers = (fn: () => Promise<number>) => (flags["check-balances"] === true ? withServiceLock("makers:fund --check-balances", fn) : fn());
  if (dryRun) return await withMakers(run);
  await requirePinnedNode();
  const lock = fundingLock("00057 makers:fund");
  try {
    return await withMakers(run);
  } finally {
    lock.release();
  }
};

/**
 * slots:unhalt <slot> [--retire] (audit F-A21): recover a halted slot. Without --retire the
 * slot goes back to `submitted` with its offer and coin claim kept (re-verified next tick);
 * with --retire the operator confirms the old offer is dead and the coin is freed.
 */
const slotsUnhalt: Command = async (flags) => {
  const slot = flag(flags, "slot");
  if (slot === undefined) throw new Error("--slot is required");
  const config = loadServiceConfig(flag(flags, "ladder-file") === undefined ? {} : { ladderFile: flag(flags, "ladder-file")! });
  const journal = openJournal({ file: config.journalFile, networkId: config.ladders.networkId, mode: config.mode });
  const how = flags["retire"] === true ? "retire" : "recheck";
  const record = journal.unhalt(slot, how);
  log(`${slot}: ${how === "retire" ? "offer retired, coin freed" : "back to submitted, claim kept"}`);
  printResult({ slot, state: record.state });
  return 0;
};

const notYet = (phase: string): Command => async () => {
  log(`not implemented yet: this command is delivered in ${phase} of plan 00053`);
  return 2;
};

export const COMMANDS: Readonly<Record<string, Command>> = {
  "wallets:generate": walletsGenerate,
  "wallets:add": walletsAdd,
  "wallets:addresses": walletsAddresses,
  "wallets:check": walletsCheck,
  "makers:status": (flags) => withServiceLock("makers:status", () => makersStatus(flags)),
  "makers:register-dust": (flags) =>
    withServiceLock("makers:register-dust", async () => {
      await requirePinnedNode();
      return await makersRegisterDust(flags);
    }),
  "makers:mint": (flags) =>
    withServiceLock("makers:mint", async () => {
      await requirePinnedNode();
      return await makersMint(flags);
    }),
  "makers:fund": makersFund,
  "ladder:once": ladderOnce,
  "ladder:run": ladderRun,
  "offers:inspect": offersInspect,
  "offers:settle": (flags) => withServiceLock("offers:settle", () => offersSettle(flags)),
  "offers:verify": offersVerify,
  "slots:unhalt": (flags) => withServiceLock("slots:unhalt", () => slotsUnhalt(flags)),
  "funding:status": (flags) => withServiceLock("funding:status", () => fundingStatus(flags)),
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const run = command === undefined ? undefined : COMMANDS[command];
  if (run === undefined) {
    console.error(`usage: bun src/cli.ts <command> [--flags]\ncommands: ${Object.keys(COMMANDS).join(", ")}`);
    return 64;
  }
  return await run(parseFlags(rest));
};

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      log(`error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      process.exit(1);
    });
}
