/**
 * Service wiring: environment + ladder file → journal, outbox, wallets, kernel client,
 * scheduler, status server. Used by `ladder:once` and `ladder:run`.
 *
 * Environment (all optional; defaults in brackets):
 *   LADDER_FILE [ladders/stagenet.json]   MODE [the ladder file's mode]
 *   TOKENS_FILE [deployments/stagenet.json] colours of stkA/B/C (00052's deployment record)
 *   ZSWAP_API [empty → outbox mode]       e.g. https://stagenet.api-zswap.zkdojo.com
 *   OFFER_TTL_MINUTES [60]  RECONCILE_SECONDS [60]  EXPIRY_GRACE_SECONDS [5]
 *   RETRY_BASE_SECONDS [60] RETRY_MAX_SECONDS [OFFER_TTL]  MAX_BUILDS_PER_TICK [0 = no limit]
 *   OUTBOX_RETENTION_HOURS [168]
 *   STATE_DIR [$HOME/.stagenet-offer-ladders/state]  JOURNAL_FILE [STATE_DIR/ladder.<mode>.journal.json]
 *   OUTBOX_DIR [STATE_DIR/outbox]  JOURNAL_RESET [false]
 *   MAKERS_FILE [$HOME/.stagenet-offer-ladders/makers.json]   (wallet-per-slot)
 *   FUNDING_WALLET_FILE [/secrets/stagenet]                     (single-wallet-pinned)
 *   WALLET_STAGGER_MS [5000]  STATUS_PORT [0 = off]  STATUS_HOST [0.0.0.0]
 *   MN_NETWORK_ID, MN_INDEXER_URL, MN_INDEXER_WS_URL, MN_NODE_URL, MN_PROOF_SERVER_URL
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openJournal, type Journal } from "./journal.ts";
import { KernelClient } from "./kernel-client.ts";
import { buildSlots, type CoinPolicy, LadderConfigError, type LadderFile, readLadderFile, resolveColours, WALLET_MODES, type WalletMode } from "./ladder.ts";
import { FUNDING_WALLET_ID, SessionPool } from "./ladder-wallet.ts";
import { fetchLedgerParameters, stagenet, type WalletNetwork } from "./network.ts";
import { Outbox } from "./outbox.ts";
import { type Log, Scheduler, type SchedulerConfig, type SlotPlan, systemClock } from "./scheduler.ts";
import { startStatusServer, type StatusServer } from "./status.ts";
import { defaultMakersFile, readMakersFile, readMnemonicFile } from "./wallets.ts";

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const num = (name: string, fallback: number, min = 0): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new LadderConfigError(`${name} must be a number ≥ ${min}, got ${raw}`);
  return value;
};

/**
 * Colours by token symbol from a deployments file. Accepts any JSON shape in which an
 * object names a symbol (`symbol` / `name` / its key) and carries a 64-hex colour
 * (`colour` / `color` / `tokenColor` / `tokenColour` / `tokenType` / `rawTokenType`).
 */
export const coloursFromDeployments = (raw: unknown, symbols: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  const wanted = new Set(symbols);
  const colourOf = (value: Record<string, unknown>): string | undefined => {
    for (const key of ["colour", "color", "tokenColour", "tokenColor", "tokenType", "rawTokenType"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/u.test(candidate)) return candidate.toLowerCase().replace(/^0x/u, "");
    }
    return undefined;
  };
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const colour = colourOf(record);
    const names = [record["symbol"], record["name"], key].filter((n): n is string => typeof n === "string");
    for (const name of names) if (colour !== undefined && wanted.has(name) && out[name] === undefined) out[name] = colour;
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(raw);
  return out;
};

export interface ServiceConfig {
  readonly ladderFile: string;
  readonly ladders: LadderFile;
  readonly mode: WalletMode;
  readonly coinPolicy: CoinPolicy;
  readonly colours: Readonly<Record<string, string>>;
  readonly slots: readonly SlotPlan[];
  readonly scheduler: SchedulerConfig;
  readonly reconcileMs: number;
  readonly zswapApi: string | undefined;
  readonly journalFile: string;
  readonly outboxDir: string;
  readonly journalReset: boolean;
  readonly makersFile: string;
  readonly fundingWalletFile: string;
  readonly walletStaggerMs: number;
  readonly statusPort: number;
  readonly statusHost: string;
  readonly network: WalletNetwork;
}

export const loadServiceConfig = (overrides: { ladderFile?: string; zswapApi?: string } = {}): ServiceConfig => {
  const ladderFile = overrides.ladderFile ?? env("LADDER_FILE") ?? "ladders/stagenet.json";
  const ladders = readLadderFile(ladderFile);
  const modeRaw = env("MODE") ?? ladders.mode;
  if (!(WALLET_MODES as readonly string[]).includes(modeRaw)) throw new LadderConfigError(`MODE must be one of ${WALLET_MODES.join(", ")}`);
  const mode = modeRaw as WalletMode;
  const coinPolicy: CoinPolicy = ladders.coinPolicy ?? (mode === "single-wallet-pinned" ? "exact" : "at-least");
  const tokensFile = env("TOKENS_FILE") ?? "deployments/stagenet.json";
  const resolved = existsSync(tokensFile) ? coloursFromDeployments(JSON.parse(readFileSync(tokensFile, "utf8")), Object.keys(ladders.tokens)) : {};
  const colours = resolveColours(ladders, resolved);
  const network = stagenet();
  if (network.networkId !== ladders.networkId) throw new LadderConfigError(`ladder file is for ${ladders.networkId}, network is ${network.networkId}`);
  const slots: SlotPlan[] = buildSlots(ladders).map((slot) => ({
    slot: slot.id,
    ladder: slot.ladder,
    level: slot.level,
    walletId: mode === "single-wallet-pinned" ? FUNDING_WALLET_ID : slot.id,
    giveColour: colours[slot.giveSymbol]!,
    wantColour: colours[slot.wantSymbol]!,
    giveAmount: slot.giveAmount.toString(),
    wantAmount: slot.wantAmount.toString(),
    price: slot.priceText,
  }));
  const ttlMinutes = num("OFFER_TTL_MINUTES", 60, 1);
  const offerTtlMs = ttlMinutes * 60_000;
  const stateDir = env("STATE_DIR") ?? join(process.env["HOME"] ?? "/root", ".stagenet-offer-ladders", "state");
  const zswapApi = overrides.zswapApi ?? env("ZSWAP_API");
  const maxBuilds = num("MAX_BUILDS_PER_TICK", 0);
  return {
    ladderFile,
    ladders,
    mode,
    coinPolicy,
    colours,
    slots,
    scheduler: {
      networkId: ladders.networkId,
      mode,
      coinPolicy,
      offerTtlMs,
      expiryGraceMs: num("EXPIRY_GRACE_SECONDS", 5) * 1000,
      retryBaseMs: num("RETRY_BASE_SECONDS", 60, 1) * 1000,
      retryMaxMs: num("RETRY_MAX_SECONDS", ttlMinutes * 60, 1) * 1000,
      excludeNonces: new Set(ladders.excludeNonces ?? []),
      maxBuildsPerTick: maxBuilds === 0 ? Number.POSITIVE_INFINITY : maxBuilds,
      outboxRetentionMs: num("OUTBOX_RETENTION_HOURS", 168) * 3_600_000,
    },
    reconcileMs: num("RECONCILE_SECONDS", 60, 1) * 1000,
    zswapApi,
    journalFile: env("JOURNAL_FILE") ?? join(stateDir, `ladder.${mode}.journal.json`),
    outboxDir: env("OUTBOX_DIR") ?? join(stateDir, "outbox"),
    journalReset: env("JOURNAL_RESET") === "true",
    makersFile: env("MAKERS_FILE") ?? defaultMakersFile(),
    fundingWalletFile: env("FUNDING_WALLET_FILE") ?? "/secrets/stagenet",
    walletStaggerMs: num("WALLET_STAGGER_MS", 5_000),
    statusPort: num("STATUS_PORT", 0),
    statusHost: env("STATUS_HOST") ?? "0.0.0.0",
    network,
  };
};

export interface Service {
  readonly config: ServiceConfig;
  readonly journal: Journal;
  readonly outbox: Outbox;
  readonly scheduler: Scheduler;
  readonly wallets: SessionPool;
  status?: StatusServer;
  close(): Promise<void>;
}

/** Log line: `phase=… key=value …`, never a secret (callers pass ids and numbers only). */
export const formatFields = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const text = typeof value === "bigint" ? value.toString() : String(value);
      return `${key}=${/\s/u.test(text) ? JSON.stringify(text) : text}`;
    })
    .join(" ");

export const createService = async (config: ServiceConfig, logLine: (line: string) => void): Promise<Service> => {
  const log: Log = (fields) => logLine(formatFields(fields));
  const journal = openJournal({ file: config.journalFile, networkId: config.ladders.networkId, mode: config.mode, reset: config.journalReset });
  const revived = journal.reviveDepleted();
  if (revived.length > 0) logLine(`re-checking depleted slots at startup: ${revived.join(", ")}`);
  const outbox = new Outbox(config.outboxDir);
  const { height, parameters } = await fetchLedgerParameters(config.network);
  logLine(`ledger parameters from block ${height}`);
  const mnemonics = new Map<string, string>();
  if (config.mode === "single-wallet-pinned") {
    mnemonics.set(FUNDING_WALLET_ID, readMnemonicFile(config.fundingWalletFile));
  } else {
    const makers = readMakersFile(config.makersFile);
    if (makers.networkId !== config.ladders.networkId) throw new LadderConfigError(`makers file is for ${makers.networkId}`);
    for (const maker of makers.makers) mnemonics.set(maker.slot, maker.mnemonic);
    const missing = config.slots.filter((slot) => !mnemonics.has(slot.walletId)).map((slot) => slot.slot);
    if (missing.length > 0) throw new LadderConfigError(`no maker wallet for slot(s) ${missing.join(", ")}`);
  }
  const wallets = new SessionPool(mnemonics, { network: config.network, dustParameters: parameters.dust, log: logLine }, config.walletStaggerMs);
  const kernel = config.zswapApi
    ? new KernelClient({ baseUrl: config.zswapApi, log: (fields) => logLine(formatFields({ ...fields })) })
    : undefined;
  const scheduler = new Scheduler({
    cfg: config.scheduler,
    slots: config.slots,
    journal,
    outbox,
    wallets,
    kernel,
    clock: systemClock,
    log,
  });
  const service: Service = {
    config,
    journal,
    outbox,
    scheduler,
    wallets,
    async close() {
      await service.status?.stop().catch(() => undefined);
      await wallets.closeAll();
    },
  };
  if (config.statusPort > 0) {
    const startedAt = Date.now();
    service.status = startStatusServer(
      {
        journal,
        startedAt,
        delivery: kernel ? "kernel" : "outbox",
        mode: config.mode,
        lastTickEndedAt: () => scheduler.lastProgressAt,
        inventory: (slot) => scheduler.inventory(slot),
        now: () => Date.now(),
      },
      { port: config.statusPort, hostname: config.statusHost, staleAfterMs: Math.max(3 * config.reconcileMs, 10 * 60_000) },
    );
    logLine(`status on :${service.status.port} (/health, /status)`);
  }
  return service;
};
