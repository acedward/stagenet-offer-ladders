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

import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";

import { buildPublicMakers, checkMakers, type PublicMakersFile, renderPublicMakersMarkdown } from "./addresses.ts";
import { readLadderFile } from "./ladder.ts";
import { fetchLedgerParameters, stagenet } from "./network.ts";
import { inspectOffer } from "./offer-inspect.ts";
import { openJournal } from "./journal.ts";
import { Outbox } from "./outbox.ts";
import { createService, fundingLock, loadServiceConfig } from "./service.ts";
import { takeServiceLock } from "./service-lock.ts";
import { startWatchdog } from "./watchdog.ts";
import { openMakerOps } from "./maker-ops.ts";
import { mintAll, registerDustAll } from "./makers.ts";
import { settleOffer } from "./settle.ts";
import type { TokenId } from "./tokens.ts";
import { verifyCurrentOffers } from "./verify.ts";
import { WalletSession } from "./wallet-session.ts";
import {
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

export const log = (line: string): void => {
  console.error(`[${new Date().toISOString()}] ${line}`);
};

const jsonReplacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);
export const printResult = (result: unknown): void => {
  console.log(JSON.stringify(result, jsonReplacer, 2));
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

/** makers:status --slots AB-01,BC-01 [--stagger-ms 2000]: sync makers ONE AT A TIME. */
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
        night: balances.night,
        nightUtxos: balances.nightUtxos.length,
        dust: balances.dust,
        shielded: Object.fromEntries(
          Object.entries(balances.shielded).map(([colour, value]) => [colour, { value, coins: balances.shieldedCoins[colour] ?? 0 }]),
        ),
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
  const result = verifyCurrentOffers(journal, outbox, { ...(pool ? { pool } : {}), reserves });
  printResult({ result: result.pass ? "PASS" : "FAIL", ...result });
  return result.pass ? 0 : 1;
};

/**
 * offers:settle --slot AB-02 --pay-with <coin nonce> [--ladder-file f] [--offer-id id]:
 * settle a slot's current offer on chain as a taker, with the FUNDING wallet, paying with
 * the named (pinned) coin of the want colour.
 */
const offersSettle: Command = async (flags) => {
  const overrides: { ladderFile?: string } = {};
  const ladderFile = flag(flags, "ladder-file");
  if (ladderFile !== undefined) overrides.ladderFile = ladderFile;
  const config = loadServiceConfig(overrides);
  const slot = flag(flags, "slot");
  const payWith = flag(flags, "pay-with");
  if (slot === undefined || payWith === undefined || !/^[0-9a-f]{64}$/u.test(payWith)) {
    throw new Error("--slot and --pay-with <64-hex coin nonce> are required");
  }
  const journal = openJournal({ file: config.journalFile, networkId: config.ladders.networkId, mode: config.mode });
  const record = journal.get(slot);
  if (record === undefined) throw new Error(`no slot ${slot} in the journal`);
  const offerId = flag(flags, "offer-id") ?? record.current?.offerId;
  if (offerId === undefined) throw new Error(`slot ${slot} has no current offer (state ${record.state})`);
  const entry = new Outbox(config.outboxDir).get(offerId);
  if (entry === undefined) throw new Error(`outbox has no offer ${offerId}`);
  const lock = fundingLock("00053 offers:settle");
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
  const recordFile = `${process.env["STATE_DIR"]?.trim() || `${process.env["HOME"]}/.stagenet-offer-ladders/state`}/maker-mints.json`;
  const record: Record<string, unknown> = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : {};
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
          minted: new Set(Object.keys(record)),
          onMinted: (slot, detail) => {
            record[slot] = { ...detail, token: give.symbol, at: new Date().toISOString() };
            writePublicFile(recordFile, `${JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
          },
        },
      )),
    );
  }
  printResult({ networkId: makers.networkId, results });
  return results.some((r) => r.action === "error" || r.action === "mint-failed") ? 1 : 0;
};

const notYet = (phase: string): Command => async () => {
  log(`not implemented yet: this command is delivered in ${phase} of plan 00053`);
  return 2;
};

export const COMMANDS: Readonly<Record<string, Command>> = {
  "wallets:generate": walletsGenerate,
  "wallets:addresses": walletsAddresses,
  "wallets:check": walletsCheck,
  "makers:status": (flags) => withServiceLock("makers:status", () => makersStatus(flags)),
  "makers:register-dust": (flags) => withServiceLock("makers:register-dust", () => makersRegisterDust(flags)),
  "makers:mint": (flags) => withServiceLock("makers:mint", () => makersMint(flags)),
  "ladder:once": ladderOnce,
  "ladder:run": ladderRun,
  "offers:inspect": offersInspect,
  "offers:settle": (flags) => withServiceLock("offers:settle", () => offersSettle(flags)),
  "offers:verify": offersVerify,
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
