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
import { dirname, join } from "node:path";

import { openJournal, type Journal } from "./journal.ts";
import { KernelClient } from "./kernel-client.ts";
import { buildSlots, type CoinPolicy, LadderConfigError, type LadderFile, readLadderFile, resolveColours, validateColours, WALLET_MODES, type WalletMode } from "./ladder.ts";
import { FUNDING_WALLET_ID, SessionPool } from "./ladder-wallet.ts";
import { fetchLedgerParameters, fetchNodeVersion, stagenet, type WalletNetwork } from "./network.ts";
import { type ServiceLock, takeServiceLock } from "./service-lock.ts";
import { Outbox } from "./outbox.ts";
import { type Log, Scheduler, type SchedulerConfig, type SlotPlan, systemClock } from "./scheduler.ts";
import { stateDir, takeFundingLock } from "./state.ts";
import { redact } from "./redact.ts";
import { startStatusServer, type StatusServer } from "./status.ts";
import { defaultMakersFile, readMakersFile, readMnemonicFile } from "./wallets.ts";

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/**
 * Default `ROOT_WINDOW_MINUTES` (P12): 14 days. Ledger 9, which stagenet runs (protocol
 * 2000000), keeps zswap Merkle roots for `global_ttl` = 1,209,600 s, so an offer built on a
 * root stays settleable for up to 14 days. (Ledger 7/8 hard-coded a 1-hour window; the
 * original "re-send hourly" plan assumed that.) The bound only ever delays a rebuild: a coin
 * is re-offered when the kernel says the old offer is expired or consumed, or when the kernel
 * no longer lists it and this bound has passed.
 */
export const DEFAULT_ROOT_WINDOW_MINUTES = 20_160;

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

/**
 * The funding wallet is shared (00052's tools, other projects): every process that opens it
 * holds `funding.lock` in the state directory (00052's `src/state.ts`). With
 * `FUNDING_LOCK_HELD=true` an operator already holds it for a whole test phase; the lock
 * file must then exist.
 */
export const fundingLock = (purpose: string): { release(): void } => {
  if (env("FUNDING_LOCK_HELD") === "true") {
    const path = join(stateDir(), "funding.lock");
    if (!existsSync(path)) throw new LadderConfigError(`FUNDING_LOCK_HELD=true but ${path} does not exist`);
    return { release: () => undefined };
  }
  return takeFundingLock(purpose);
};

/**
 * Wait (up to `timeoutMs`) for the proof server's `/health` before the first tick (audit
 * F-A19: the proof-server image has no shell for a Compose health check). Failing = exit, so
 * the restart policy tries again.
 */
export const waitForProver = async (url: string, logLine: (line: string) => void, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) throw new Error(`proof server ${url} not healthy after ${timeoutMs / 1000} s`);
    logLine("waiting for the proof server");
    await new Promise((r) => setTimeout(r, 5_000));
  }
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
  readonly stateDir: string;
  /** Pinned node version; empty = no check (audit C12). */
  readonly expectedNodeVersion: string;
  /** Exit when no slot has made progress for this long (audit C6). */
  readonly watchdogMs: number;
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
  validateColours(ladders, colours);
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
      // Margin past the root window: the kernel counts from the root's LAST-SEEN time, a
      // little after the build (audit C7 verification). Conservative default: 5 min.
      expiryGraceMs: num("EXPIRY_GRACE_SECONDS", 300) * 1000,
      retryBaseMs: num("RETRY_BASE_SECONDS", 60, 1) * 1000,
      retryMaxMs: num("RETRY_MAX_SECONDS", ttlMinutes * 60, 1) * 1000,
      excludeNonces: new Set(ladders.excludeNonces ?? []),
      includeNonces: ladders.includeNonces ? new Set(ladders.includeNonces) : undefined,
      maxBuildsPerTick: maxBuilds === 0 ? Number.POSITIVE_INFINITY : maxBuilds,
      outboxRetentionMs: num("OUTBOX_RETENTION_HOURS", 168) * 3_600_000,
      rootWindowMs: num("ROOT_WINDOW_MINUTES", DEFAULT_ROOT_WINDOW_MINUTES, 1) * 60_000,
      submitConfirmMs: num("SUBMIT_CONFIRM_SECONDS", 300, 1) * 1000,
      buildTimeoutMs: num("BUILD_TIMEOUT_SECONDS", 300, 1) * 1000,
      versionCheckEveryTicks: num("VERSION_CHECK_EVERY_TICKS", 10),
      freshStartAck: env("FRESH_START_ACK"),
    },
    reconcileMs: num("RECONCILE_SECONDS", 60, 1) * 1000,
    stateDir,
    expectedNodeVersion: process.env["EXPECTED_NODE_VERSION"] ?? "2.0.0-d9729c13",
    // Audit F-B16: never shorter than the initial wallet-sync deadline (20 min) plus a margin.
    watchdogMs: Math.max(
      30 * 60_000,
      num("WATCHDOG_SECONDS", 0) * 1000,
      3 * num("RECONCILE_SECONDS", 60, 1) * 1000 + 2 * num("BUILD_TIMEOUT_SECONDS", 300, 1) * 1000,
    ),
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
  readonly lock: ServiceLock;
  status?: StatusServer;
  close(): Promise<void>;
}

/** Log line: `phase=… key=value …`, never a secret (callers pass ids and numbers only). */
export const formatFields = (fields: Record<string, unknown>): string => redact(joinFields(fields));

const joinFields = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const text = redact(typeof value === "bigint" ? value.toString() : String(value)); // before quoting (F-B29)
      return `${key}=${/\s/u.test(text) ? JSON.stringify(text) : text}`;
    })
    .join(" ");

export const createService = async (config: ServiceConfig, logLine: (line: string) => void): Promise<Service> => {
  const log: Log = (fields) => logLine(formatFields(fields));
  // Audit C4: one process per state directory (journal writer + maker seeds).
  const serviceLock = takeServiceLock(config.stateDir, "ladder service");
  try {
    return await createServiceLocked(config, logLine, log, serviceLock);
  } catch (error) {
    serviceLock.release();
    throw error;
  }
};

/** A journal of the OTHER wallet mode in the same directory that still claims coins (audit C1). */
const otherModeClaims = (config: ServiceConfig): string | undefined => {
  const other = config.mode === "single-wallet-pinned" ? "wallet-per-slot" : "single-wallet-pinned";
  const file = join(dirname(config.journalFile), `ladder.${other}.journal.json`);
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { slots?: Record<string, { state?: string }> };
    const claiming = Object.values(data.slots ?? {}).filter((s) => ["posting", "stored", "submitted", "live", "halted"].includes(String(s.state)));
    return claiming.length > 0 ? `${file} still has ${claiming.length} outstanding offer(s)` : undefined;
  } catch {
    return `${file} is unreadable`;
  }
};

const createServiceLocked = async (config: ServiceConfig, logLine: (line: string) => void, log: Log, serviceLock: ServiceLock): Promise<Service> => {
  const conflict = otherModeClaims(config);
  if (conflict !== undefined && !config.journalReset) {
    throw new LadderConfigError(`refusing to start in ${config.mode}: ${conflict}; retire those offers first (or JOURNAL_RESET=true)`);
  }
  const journal = openJournal({ file: config.journalFile, networkId: config.ladders.networkId, mode: config.mode, reset: config.journalReset });
  const revived = journal.reviveDepleted();
  if (revived.length > 0) logLine(`re-checking depleted slots at startup: ${revived.join(", ")}`);
  const outbox = new Outbox(config.outboxDir);
  await waitForProver(config.network.proofServerUrl, logLine);
  const { height, parameters } = await fetchLedgerParameters(config.network);
  logLine(`ledger parameters from block ${height}`);
  const mnemonics = new Map<string, string>();
  let lock: { release(): void } | undefined;
  if (config.mode === "single-wallet-pinned") {
    lock = fundingLock("00053 ladder service (single-wallet-pinned)");
    mnemonics.set(FUNDING_WALLET_ID, readMnemonicFile(config.fundingWalletFile));
  } else {
    const makers = readMakersFile(config.makersFile);
    if (makers.networkId !== config.ladders.networkId) throw new LadderConfigError(`makers file is for ${makers.networkId}`);
    // Audit C4: two slots must never share a wallet (identical mnemonics = identical identities).
    if (new Set(makers.makers.map((m) => m.mnemonic)).size !== makers.makers.length) {
      throw new LadderConfigError("the makers file has duplicate wallets (two slots derive the same identity)");
    }
    for (const maker of makers.makers) mnemonics.set(maker.slot, maker.mnemonic);
    const missing = config.slots.filter((slot) => !mnemonics.has(slot.walletId)).map((slot) => slot.slot);
    if (missing.length > 0) throw new LadderConfigError(`no maker wallet for slot(s) ${missing.join(", ")}`);
  }
  let progress: () => void = () => undefined; // bound to the scheduler below (audit F-B28)
  const wallets = new SessionPool(
    mnemonics,
    { network: config.network, dustParameters: parameters.dust, log: logLine, onProgress: () => progress() },
    config.walletStaggerMs,
  );
  const kernel = config.zswapApi
    ? new KernelClient({ baseUrl: config.zswapApi, log: (fields) => logLine(formatFields({ ...fields })), onSleep: () => progress() })
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
    versionGuard:
      config.expectedNodeVersion === ""
        ? undefined
        : async () => {
            const actual = await fetchNodeVersion(config.network);
            return actual === config.expectedNodeVersion ? null : `node version ${actual} != pinned ${config.expectedNodeVersion}`;
          },
    ownsLock: () => serviceLock.held(),
    onFatal: (reason) => {
      logLine(`fatal: ${reason}; exiting so the restart policy recovers`);
      setTimeout(() => process.exit(70), 1_000).unref?.();
    },
  });
  progress = () => scheduler.noteProgress();
  const service: Service = {
    config,
    journal,
    outbox,
    scheduler,
    wallets,
    lock: serviceLock,
    async close() {
      await service.status?.stop().catch(() => undefined);
      await wallets.closeAll();
      lock?.release();
      serviceLock.release();
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
        haltReason: () => scheduler.haltReason,
        inventory: (slot) => scheduler.inventory(slot),
        now: () => Date.now(),
      },
      { port: config.statusPort, hostname: config.statusHost, staleAfterMs: Math.max(3 * config.reconcileMs, 10 * 60_000) },
    );
    logLine(`status on :${service.status.port} (/health, /status)`);
  }
  return service;
};
