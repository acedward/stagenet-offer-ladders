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
import { createService, loadServiceConfig } from "./service.ts";
import { WalletSession } from "./wallet-session.ts";
import {
  defaultMakersFile,
  generateMakers,
  identityOf,
  planMakerSlots,
  readMakersFile,
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
    printResult({ report, states: service.journal.summary().byState });
    return report.errors > 0 ? 1 : 0;
  } finally {
    await service.close();
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
  try {
    await service.scheduler.loop(config.reconcileMs, controller.signal);
  } finally {
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

const notYet = (phase: string): Command => async () => {
  log(`not implemented yet: this command is delivered in ${phase} of plan 00053`);
  return 2;
};

export const COMMANDS: Readonly<Record<string, Command>> = {
  "wallets:generate": walletsGenerate,
  "wallets:addresses": walletsAddresses,
  "wallets:check": walletsCheck,
  "makers:status": makersStatus,
  "makers:register-dust": notYet("P4"),
  "makers:mint": notYet("P4"),
  "ladder:once": ladderOnce,
  "ladder:run": ladderRun,
  "offers:inspect": offersInspect,
  "offers:settle": notYet("P3"),
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
