/**
 * The ladder service's durable per-slot record (spec FR-005, US4).
 *
 * One JSON file on the service's volume. Per slot it holds the state machine
 *
 *     idle → posting → live{offerId, coinNonce, expiresAt}
 *                        → consumed | expired | rejected | error → (re-offer) → posting …
 *     any → depleted   (no eligible give coin left: terminal, not an error)
 *
 * plus the coin the slot is pinned to and a bounded history of ended offers.
 *
 * `posting` is written BEFORE an offer leaves the process (after its blob is in the
 * outbox), so a crash between "built" and "acknowledged" is recovered by re-posting the
 * SAME blob, never by building a second offer on the same coin.
 *
 * Persistence (adapted from `zswap-offerfiles-kernel` @ 67db767
 * `deploy/scripts/lib/poster-journal.ts`, Apache-2.0):
 * - every mutation is on disk before the call returns: temp file → fsync → rename, so a
 *   crash leaves the old file or the new one, never half;
 * - a file that does not parse, or is not this schema, is MOVED ASIDE (never overwritten)
 *   and the open is refused unless `reset`; a journal for another network or mode is
 *   refused and left in place;
 * - `bigint` never reaches JSON: amounts are canonical decimal strings.
 *
 * Pure apart from the file: no network, no wallet; the clock is injected.
 *
 * @module
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const JOURNAL_VERSION = 1 as const;

export const SLOT_STATES = ["idle", "posting", "live", "consumed", "expired", "rejected", "error", "depleted"] as const;
export type SlotState = (typeof SLOT_STATES)[number];

/** States from which the scheduler builds a new offer (subject to backoff). */
export const REOFFER_STATES: readonly SlotState[] = ["idle", "consumed", "expired", "rejected", "error"];
/** States in which the slot's coin is claimed by an outstanding offer. */
export const CLAIMING_STATES: readonly SlotState[] = ["posting", "live"];

export type Delivery = "kernel" | "outbox";
export type OfferOutcome = "consumed" | "expired" | "rejected" | "error" | "superseded";

export interface OfferRef {
  /** Content hash: sha256 of the raw transaction bytes, 64 lowercase hex. */
  readonly offerId: string;
  /** sha256 of the `swapoffer1…` string. */
  readonly blobSha256: string;
  readonly delivery: Delivery;
  readonly coinNonce: string;
  readonly coinNullifier: string;
  /** Base units, canonical decimal strings. */
  readonly coinValue: string;
  readonly giveAmount: string;
  readonly wantAmount: string;
  readonly ttlSec: number;
  readonly builtAt: string;
  readonly expiresAt: string;
  postedAt?: string;
  postAttempts?: number;
  outcome?: OfferOutcome;
  endedAt?: string;
  code?: string;
}

export interface SlotDefinition {
  readonly slot: string;
  readonly ladder: string;
  readonly level: number;
  readonly walletId: string;
  readonly giveColour: string;
  readonly wantColour: string;
  /** Base units, canonical decimal strings. */
  readonly giveAmount: string;
  readonly wantAmount: string;
  /** Price, 3 decimals (display). */
  readonly price: string;
}

export interface SlotRecord extends SlotDefinition {
  state: SlotState;
  stateAt: string;
  /** The coin this slot is pinned to (kept across re-offers of an expired offer). */
  coinNonce?: string;
  current?: OfferRef;
  history: OfferRef[];
  cycles: number;
  consecutiveFailures: number;
  nextAttemptAt?: string;
  lastError?: { code: string; message: string; at: string };
  depletedReason?: string;
}

export interface JournalData {
  version: typeof JOURNAL_VERSION;
  networkId: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  slots: Record<string, SlotRecord>;
}

export type JournalErrorCode =
  | "CORRUPT"
  | "NETWORK_MISMATCH"
  | "MODE_MISMATCH"
  | "SLOT_MISMATCH"
  | "UNKNOWN_SLOT"
  | "BAD_TRANSITION"
  | "INVALID_ARGUMENT";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  readonly movedAside?: string;
  constructor(code: JournalErrorCode, message: string, movedAside?: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
    if (movedAside !== undefined) this.movedAside = movedAside;
  }
}

/** Ended offers kept per slot. */
export const HISTORY_LIMIT = 50;

const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** temp → fsync → rename. The temp is removed on any failure. */
export function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the write already failed */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function moveAside(file: string, suffix: string, now: Date): string {
  const base = `${file}.${suffix}-${now.toISOString().replace(/:/gu, "-")}`;
  let target = base;
  for (let n = 1; existsSync(target); n++) target = `${base}-${n}`;
  renameSync(file, target);
  return target;
}

function validationFailure(data: unknown): string | null {
  if (!isRecord(data)) return "top level is not an object";
  if (data["version"] !== JOURNAL_VERSION) return `unsupported version ${JSON.stringify(data["version"])}`;
  for (const key of ["networkId", "mode", "createdAt", "updatedAt"]) {
    if (typeof data[key] !== "string" || data[key] === "") return `"${key}" must be a non-empty string`;
  }
  const slots = data["slots"];
  if (!isRecord(slots)) return '"slots" must be an object';
  for (const [id, raw] of Object.entries(slots)) {
    if (!isRecord(raw)) return `slot ${id} is not an object`;
    if (raw["slot"] !== id) return `slot ${id}: "slot" does not match its key`;
    if (!(SLOT_STATES as readonly unknown[]).includes(raw["state"])) return `slot ${id}: unknown state ${JSON.stringify(raw["state"])}`;
    for (const key of ["giveAmount", "wantAmount"]) {
      if (typeof raw[key] !== "string" || !CANONICAL_UINT.test(raw[key] as string)) return `slot ${id}: "${key}" must be a decimal string`;
    }
    for (const key of ["giveColour", "wantColour"]) {
      if (typeof raw[key] !== "string" || !HEX64.test(raw[key] as string)) return `slot ${id}: "${key}" must be 64 hex`;
    }
    if (!Array.isArray(raw["history"])) return `slot ${id}: "history" must be an array`;
    const state = raw["state"] as SlotState;
    if (CLAIMING_STATES.includes(state)) {
      const current = raw["current"];
      if (!isRecord(current) || typeof current["offerId"] !== "string" || typeof current["expiresAt"] !== "string") {
        return `slot ${id}: state ${state} needs a current offer`;
      }
    }
  }
  return null;
}

export interface OpenJournalOptions {
  readonly file: string;
  readonly networkId: string;
  readonly mode: string;
  /** Move an unusable or foreign journal aside and start fresh instead of refusing. */
  readonly reset?: boolean;
  readonly now?: () => Date;
}

/** Counts for `/status` and logs. */
export interface JournalSummary {
  readonly slots: number;
  readonly byState: Record<SlotState, number>;
  readonly offersBuilt: number;
}

export class Journal {
  readonly file: string;
  #data: JournalData;
  readonly #now: () => Date;

  private constructor(file: string, data: JournalData, now: () => Date) {
    this.file = file;
    this.#data = data;
    this.#now = now;
  }

  /** @internal */
  static _create(file: string, data: JournalData, now: () => Date): Journal {
    return new Journal(file, data, now);
  }

  get networkId(): string {
    return this.#data.networkId;
  }

  get mode(): string {
    return this.#data.mode;
  }

  toJSON(): JournalData {
    return structuredClone(this.#data);
  }

  get(slot: string): SlotRecord | undefined {
    const record = this.#data.slots[slot];
    return record === undefined ? undefined : structuredClone(record);
  }

  slots(): SlotRecord[] {
    return Object.values(this.#data.slots).map((record) => structuredClone(record));
  }

  /** Nonces claimed by an outstanding (posting/live) offer of any slot, except `exceptSlot`. */
  claimedNonces(exceptSlot?: string): Set<string> {
    const out = new Set<string>();
    for (const record of Object.values(this.#data.slots)) {
      if (record.slot === exceptSlot) continue;
      if (CLAIMING_STATES.includes(record.state) && record.current) out.add(record.current.coinNonce);
    }
    return out;
  }

  /** Nonces pinned to a slot (assigned), except `exceptSlot`'s. A pinned coin is never given to another slot. */
  assignedNonces(exceptSlot?: string): Set<string> {
    const out = new Set<string>();
    for (const record of Object.values(this.#data.slots)) {
      if (record.slot === exceptSlot) continue;
      if (record.coinNonce !== undefined && record.state !== "consumed" && record.state !== "depleted") out.add(record.coinNonce);
    }
    return out;
  }

  summary(): JournalSummary {
    const byState = Object.fromEntries(SLOT_STATES.map((s) => [s, 0])) as Record<SlotState, number>;
    let offersBuilt = 0;
    for (const record of Object.values(this.#data.slots)) {
      byState[record.state] += 1;
      offersBuilt += record.cycles;
    }
    return { slots: Object.keys(this.#data.slots).length, byState, offersBuilt };
  }

  // ── mutations (each persists before returning) ─────────────────────────────

  /**
   * Add a slot, or check that an existing one still has the same definition. A slot's
   * price and amounts are fixed for its life: a changed definition is refused.
   */
  ensureSlot(definition: SlotDefinition): SlotRecord {
    const existing = this.#data.slots[definition.slot];
    if (existing !== undefined) {
      for (const key of ["ladder", "walletId", "giveColour", "wantColour", "giveAmount", "wantAmount"] as const) {
        if (existing[key] !== definition[key]) {
          throw new JournalError(
            "SLOT_MISMATCH",
            `slot ${definition.slot}: journal has ${key}=${existing[key]}, config has ${definition[key]}; ` +
              "a slot's definition is fixed for its life (use a new journal file, or reset)",
          );
        }
      }
      return structuredClone(existing);
    }
    for (const key of ["giveColour", "wantColour"] as const) {
      if (!HEX64.test(definition[key])) throw new JournalError("INVALID_ARGUMENT", `slot ${definition.slot}: ${key} must be 64 hex`);
    }
    for (const key of ["giveAmount", "wantAmount"] as const) {
      if (!CANONICAL_UINT.test(definition[key])) throw new JournalError("INVALID_ARGUMENT", `slot ${definition.slot}: ${key} must be a decimal string`);
    }
    const record: SlotRecord = {
      ...definition,
      state: "idle",
      stateAt: this.#iso(),
      history: [],
      cycles: 0,
      consecutiveFailures: 0,
    };
    this.#data.slots[definition.slot] = record;
    this.#persist();
    return structuredClone(record);
  }

  /** A new offer was built and its blob is in the outbox: the slot is `posting`. */
  beginOffer(slot: string, ref: Omit<OfferRef, "postedAt" | "outcome" | "endedAt" | "code">): SlotRecord {
    const record = this.#require(slot);
    if (!REOFFER_STATES.includes(record.state)) {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot begin an offer from state ${record.state}`);
    }
    const claimed = this.claimedNonces(slot);
    if (claimed.has(ref.coinNonce)) {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: coin ${ref.coinNonce.slice(0, 12)}… is claimed by another slot's live offer`);
    }
    record.current = { ...ref, postAttempts: 0 };
    record.coinNonce = ref.coinNonce;
    record.state = "posting";
    record.stateAt = this.#iso();
    record.cycles += 1;
    delete record.depletedReason;
    this.#persist();
    return structuredClone(record);
  }

  /** Count a post attempt of the current offer (kept `posting`). */
  notePostAttempt(slot: string, code?: string): SlotRecord {
    const record = this.#require(slot);
    if (record.state !== "posting" || !record.current) throw new JournalError("BAD_TRANSITION", `slot ${slot}: not posting`);
    record.current.postAttempts = (record.current.postAttempts ?? 0) + 1;
    if (code !== undefined) record.current.code = code;
    this.#persist();
    return structuredClone(record);
  }

  /** The kernel accepted the offer (or the outbox holds it): `live`. */
  markLive(slot: string): SlotRecord {
    const record = this.#require(slot);
    if (record.state !== "posting" && record.state !== "live") {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot go live from state ${record.state}`);
    }
    if (!record.current) throw new JournalError("BAD_TRANSITION", `slot ${slot}: no current offer`);
    record.current.postedAt ??= this.#iso();
    record.state = "live";
    record.stateAt = this.#iso();
    record.consecutiveFailures = 0;
    delete record.nextAttemptAt;
    delete record.lastError;
    this.#persist();
    return structuredClone(record);
  }

  /**
   * End the current offer with an outcome; the slot takes that state. `consumed` also
   * releases the pinned coin (it is spent); `rejected` / `error` set a retry time.
   */
  endOffer(slot: string, outcome: Exclude<OfferOutcome, "superseded">, detail: { code?: string; message?: string; retryAt?: Date } = {}): SlotRecord {
    const record = this.#require(slot);
    if (!CLAIMING_STATES.includes(record.state) || !record.current) {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: no outstanding offer to end (state ${record.state})`);
    }
    const ended: OfferRef = { ...record.current, outcome, endedAt: this.#iso() };
    if (detail.code !== undefined) ended.code = detail.code;
    record.history.push(ended);
    if (record.history.length > HISTORY_LIMIT) record.history.splice(0, record.history.length - HISTORY_LIMIT);
    delete record.current;
    record.state = outcome;
    record.stateAt = this.#iso();
    if (outcome === "consumed") delete record.coinNonce;
    if (outcome === "rejected" || outcome === "error") {
      record.consecutiveFailures += 1;
      record.lastError = { code: detail.code ?? outcome, message: detail.message ?? "", at: this.#iso() };
      if (detail.retryAt) record.nextAttemptAt = detail.retryAt.toISOString();
    } else {
      record.consecutiveFailures = 0;
      delete record.nextAttemptAt;
    }
    this.#persist();
    return structuredClone(record);
  }

  /** A failure before any offer existed (build failed, coin vanished): `error` with a retry time. */
  markError(slot: string, code: string, message: string, retryAt: Date): SlotRecord {
    const record = this.#require(slot);
    if (CLAIMING_STATES.includes(record.state)) {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: use endOffer while an offer is outstanding`);
    }
    record.state = "error";
    record.stateAt = this.#iso();
    record.consecutiveFailures += 1;
    record.lastError = { code, message: message.slice(0, 500), at: this.#iso() };
    record.nextAttemptAt = retryAt.toISOString();
    this.#persist();
    return structuredClone(record);
  }

  /** No eligible give coin is left for this slot. Terminal (not an error). */
  markDepleted(slot: string, reason: string): SlotRecord {
    const record = this.#require(slot);
    if (CLAIMING_STATES.includes(record.state)) {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot deplete while an offer is outstanding`);
    }
    record.state = "depleted";
    record.stateAt = this.#iso();
    record.depletedReason = reason;
    delete record.coinNonce;
    delete record.nextAttemptAt;
    this.#persist();
    return structuredClone(record);
  }

  /**
   * Re-open depleted slots (the runner calls this once at startup, so a top-up plus a
   * restart revives a slot). Returns the slots re-opened.
   */
  reviveDepleted(): string[] {
    const revived: string[] = [];
    for (const record of Object.values(this.#data.slots)) {
      if (record.state !== "depleted") continue;
      record.state = "idle";
      record.stateAt = this.#iso();
      revived.push(record.slot);
    }
    if (revived.length > 0) this.#persist();
    return revived;
  }

  flush(): void {
    this.#persist();
  }

  #require(slot: string): SlotRecord {
    const record = this.#data.slots[slot];
    if (record === undefined) throw new JournalError("UNKNOWN_SLOT", `no slot ${slot} in the journal`);
    return record;
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #persist(): void {
    this.#data.updatedAt = this.#iso();
    writeAtomic(this.file, `${JSON.stringify(this.#data, null, 2)}\n`);
  }
}

/**
 * Open (or create) the journal.
 * - missing → fresh, written immediately;
 * - unparseable / invalid → moved to `<file>.corrupt-<stamp>`, then `CORRUPT` unless `reset`;
 * - other network or mode → refused and left in place, unless `reset` (moved to
 *   `<file>.superseded-<stamp>`).
 */
export function openJournal(options: OpenJournalOptions): Journal {
  const now = options.now ?? (() => new Date());
  const { file, reset = false } = options;
  const networkId = String(options.networkId ?? "").trim().toLowerCase();
  const mode = String(options.mode ?? "").trim();
  if (file === "" || networkId === "" || mode === "") {
    throw new JournalError("INVALID_ARGUMENT", "journal file, networkId and mode are required");
  }
  mkdirSync(dirname(file), { recursive: true });
  const fresh = (): Journal => {
    const at = now().toISOString();
    const journal = Journal._create(file, { version: JOURNAL_VERSION, networkId, mode, createdAt: at, updatedAt: at, slots: {} }, now);
    journal.flush();
    return journal;
  };
  if (!existsSync(file)) return fresh();

  let parsed: unknown;
  let problem: string | null = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problem = `not valid JSON: ${(error as Error).message}`;
  }
  if (problem === null) problem = validationFailure(parsed);
  if (problem !== null) {
    const movedAside = moveAside(file, "corrupt", now());
    if (!reset) {
      throw new JournalError("CORRUPT", `journal ${file} is unusable (${problem}); moved to ${movedAside}. Restore it, or start with reset.`, movedAside);
    }
    return fresh();
  }
  const data = parsed as JournalData;
  const mismatch =
    data.networkId.toLowerCase() !== networkId
      ? { code: "NETWORK_MISMATCH" as const, detail: `journal is for network ${data.networkId}, this service runs on ${networkId}` }
      : data.mode !== mode
        ? { code: "MODE_MISMATCH" as const, detail: `journal was written in mode ${data.mode}, this service runs in ${mode}` }
        : null;
  if (mismatch !== null) {
    if (!reset) throw new JournalError(mismatch.code, `${mismatch.detail}; point the journal elsewhere or start with reset`);
    moveAside(file, "superseded", now());
    return fresh();
  }
  return Journal._create(file, data, now);
}
