/**
 * The ladder service's durable per-slot record (spec FR-005, US4).
 *
 * One JSON file on the service's volume. Per slot it holds the state machine
 *
 *     idle → stored → submitted → live{offerId, coinNonce, expiresAt}
 *                        → consumed | expired | rejected | error → (re-offer) → stored …
 *     any → depleted   (no eligible give coin left: terminal, not an error)
 *     claiming → halted (the coin stays claimed; an operator decides)
 *
 * `stored` = built and in the outbox (the destination in outbox mode); `submitted` = the
 * kernel accepted it; `live` = the kernel reports it live. Audit C7.
 *
 * plus the coin the slot is pinned to and a bounded history of ended offers.
 *
 * `stored` is written BEFORE an offer leaves the process (after its blob is in the
 * outbox), so a crash between "built" and "acknowledged" is recovered by re-posting the
 * SAME blob, never by building a second offer on the same coin.
 *
 * Audit C3: every mutation is applied to a CANDIDATE copy, the candidate is persisted,
 * and only then does it replace the in-memory state; a failed write changes nothing.
 * Audit C2: a corrupt journal is moved aside AND a quarantine marker is written next to
 * it; every later start refuses until an explicit reset.
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
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { redact } from "./redact.ts";

export const JOURNAL_VERSION = 1 as const;

export const SLOT_STATES = [
  "idle",
  "stored",
  "submitted",
  "live",
  "consumed",
  "expired",
  "rejected",
  "error",
  "depleted",
  "halted",
] as const;
export type SlotState = (typeof SLOT_STATES)[number];

/** States from which the scheduler builds a new offer (subject to backoff). */
export const REOFFER_STATES: readonly SlotState[] = ["idle", "consumed", "expired", "rejected", "error"];
/** States in which the slot's coin is claimed by an outstanding offer. */
export const CLAIMING_STATES: readonly SlotState[] = ["stored", "submitted", "live", "halted"];

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
  /** Last POST attempt, successful or not (re-post cadence; audit C7 verification). */
  lastPostAttemptAt?: string;
  /** The kernel's input nullifiers were read and matched when it first listed the offer live. */
  verified?: boolean;
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
  /**
   * Audit F-B15: set when this journal was created from nothing. Until an operator
   * acknowledges it (FRESH_START_ACK=<this journal's token>, after checking that no earlier
   * offer of these wallets can still be live), the service builds and adopts nothing. The
   * value is a one-time token bound to THIS journal (audit F-A26): a flag left in `.env`
   * never acknowledges a later fresh journal. `true` is the pre-token form.
   */
  freshStart?: boolean | string;
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

/** fsync a directory so a rename in it survives a power loss (best effort where unsupported). */
export function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    // Only "this filesystem cannot fsync a directory" is tolerated; a real I/O error
    // fails the write (audit C3 verification).
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** temp → fsync → rename → fsync(directory). The temp is removed on any failure. */
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
    fsyncDirectory(dirname(file));
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
    if (raw["state"] === "posting") raw["state"] = "stored"; // journal written before audit C7
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
  /** The durable write (tests inject failures). Default: `writeAtomic`. */
  readonly write?: (file: string, contents: string) => void;
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
  readonly #write: (file: string, contents: string) => void;

  private constructor(file: string, data: JournalData, now: () => Date, write: (file: string, contents: string) => void) {
    this.file = file;
    this.#data = data;
    this.#now = now;
    this.#write = write;
  }

  /** @internal */
  static _create(file: string, data: JournalData, now: () => Date, write: (file: string, contents: string) => void = writeAtomic): Journal {
    return new Journal(file, data, now, write);
  }

  get networkId(): string {
    return this.#data.networkId;
  }

  get mode(): string {
    return this.#data.mode;
  }

  /** True while a freshly created journal has not been acknowledged by an operator. */
  get needsFreshStartAck(): boolean {
    return this.#data.freshStart !== undefined && this.#data.freshStart !== false;
  }

  /** The token an operator must pass as FRESH_START_ACK to acknowledge this journal. */
  get freshStartToken(): string | undefined {
    const value = this.#data.freshStart;
    if (value === undefined || value === false) return undefined;
    return typeof value === "string" ? value : `fresh-${this.#data.createdAt.replace(/[^0-9]/gu, "")}`;
  }

  /** Acknowledge with the journal's own token; any other value (e.g. a stale `true`) is refused. */
  acknowledgeFreshStart(token: string | undefined): boolean {
    if (!this.needsFreshStartAck) return true;
    if (token === undefined || token !== this.freshStartToken) return false;
    this.#mutate((data) => {
      delete data.freshStart;
      return undefined;
    });
    return true;
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

  /** Nonces claimed by an outstanding (stored/submitted/live/halted) offer of any slot, except `exceptSlot`. */
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

  // ── mutations: candidate → persist → commit (audit C3) ─────────────────────

  /**
   * Apply `change` to a deep copy, persist the copy, and only then make it the in-memory
   * state. If `change` throws or the write fails, memory is untouched.
   */
  #mutate<T>(change: (data: JournalData) => T): T {
    const candidate = structuredClone(this.#data);
    const result = change(candidate);
    candidate.updatedAt = this.#iso();
    this.#write(this.file, `${JSON.stringify(candidate, null, 2)}\n`);
    this.#data = candidate;
    return structuredClone(result);
  }

  #requireIn(data: JournalData, slot: string): SlotRecord {
    const record = data.slots[slot];
    if (record === undefined) throw new JournalError("UNKNOWN_SLOT", `no slot ${slot} in the journal`);
    return record;
  }

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
    return this.#mutate((data) => {
      const record: SlotRecord = { ...definition, state: "idle", stateAt: this.#iso(), history: [], cycles: 0, consecutiveFailures: 0 };
      data.slots[definition.slot] = record;
      return record;
    });
  }

  #claim(data: JournalData, slot: string, ref: Omit<OfferRef, "postedAt" | "outcome" | "endedAt" | "code">, state: SlotState): SlotRecord {
    const record = this.#requireIn(data, slot);
    if (!REOFFER_STATES.includes(record.state)) {
      throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot begin an offer from state ${record.state}`);
    }
    for (const other of Object.values(data.slots)) {
      if (other.slot !== slot && CLAIMING_STATES.includes(other.state) && other.current?.coinNonce === ref.coinNonce) {
        throw new JournalError("BAD_TRANSITION", `slot ${slot}: coin ${ref.coinNonce.slice(0, 12)}… is claimed by another slot's live offer`);
      }
    }
    record.current = { ...ref, postAttempts: 0 };
    record.coinNonce = ref.coinNonce;
    record.state = state;
    record.stateAt = this.#iso();
    record.cycles += 1;
    delete record.depletedReason;
    return record;
  }

  /** A new offer was built and its blob is in the outbox: the slot is `stored`. */
  beginOffer(slot: string, ref: Omit<OfferRef, "postedAt" | "outcome" | "endedAt" | "code">): SlotRecord {
    return this.#mutate((data) => this.#claim(data, slot, ref, "stored"));
  }

  /**
   * Adopt an offer the kernel already holds for this slot's coin (audit C1). It enters
   * `submitted`, so the first-live nullifier verification runs on it too (audit F-B21).
   */
  adoptOffer(slot: string, ref: Omit<OfferRef, "postedAt" | "outcome" | "endedAt" | "code">): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#claim(data, slot, ref, "submitted");
      record.current!.postedAt = this.#iso();
      record.current!.code = "ADOPTED";
      record.consecutiveFailures = 0;
      delete record.nextAttemptAt;
      return record;
    });
  }

  /** Count a post attempt of the current offer (state unchanged). */
  notePostAttempt(slot: string, code?: string): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
      if (!CLAIMING_STATES.includes(record.state) || !record.current) throw new JournalError("BAD_TRANSITION", `slot ${slot}: no outstanding offer`);
      record.current.postAttempts = (record.current.postAttempts ?? 0) + 1;
      record.current.lastPostAttemptAt = this.#iso();
      if (code !== undefined) record.current.code = code;
      return record;
    });
  }

  /** The kernel accepted the offer: `submitted`. */
  markSubmitted(slot: string): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
      if ((record.state !== "stored" && record.state !== "submitted" && record.state !== "live") || !record.current) {
        throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot be submitted from state ${record.state}`);
      }
      record.current.postedAt = this.#iso();
      record.current.lastPostAttemptAt = this.#iso();
      record.current.postAttempts = (record.current.postAttempts ?? 0) + 1;
      if (record.state !== "live") {
        record.state = "submitted";
        record.stateAt = this.#iso();
      }
      record.consecutiveFailures = 0;
      delete record.nextAttemptAt;
      delete record.lastError;
      return record;
    });
  }

  /** The kernel reports the offer live: `live`. */
  markLive(slot: string): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
      if (record.state !== "stored" && record.state !== "submitted" && record.state !== "live") {
        throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot go live from state ${record.state}`);
      }
      if (!record.current) throw new JournalError("BAD_TRANSITION", `slot ${slot}: no current offer`);
      record.current.postedAt ??= this.#iso();
      record.current.verified = true;
      record.state = "live";
      record.stateAt = this.#iso();
      record.consecutiveFailures = 0;
      delete record.nextAttemptAt;
      delete record.lastError;
      return record;
    });
  }

  /**
   * End the current offer with an outcome; the slot takes that state. `consumed` also
   * releases the pinned coin (it is spent); `rejected` / `error` set a retry time.
   */
  endOffer(slot: string, outcome: Exclude<OfferOutcome, "superseded">, detail: { code?: string; message?: string; retryAt?: Date } = {}): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
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
        record.lastError = { code: detail.code ?? outcome, message: redact(detail.message ?? ""), at: this.#iso() };
        if (detail.retryAt) record.nextAttemptAt = detail.retryAt.toISOString();
      } else {
        record.consecutiveFailures = 0;
        delete record.nextAttemptAt;
      }
      return record;
    });
  }

  /** Stop the slot while KEEPING its offer and coin claimed (audit C7: OFFER_ID_MISMATCH). */
  halt(slot: string, code: string, message: string): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
      if (!CLAIMING_STATES.includes(record.state) || !record.current) throw new JournalError("BAD_TRANSITION", `slot ${slot}: nothing to halt`);
      record.state = "halted";
      record.stateAt = this.#iso();
      record.lastError = { code, message: redact(message).slice(0, 500), at: this.#iso() };
      return record;
    });
  }

  /**
   * Operator recovery of a halted slot (audit F-A21). `recheck` puts it back to `submitted`
   * with its offer and coin claim kept, so the next tick verifies it again; `retire` ends
   * the offer (the operator confirmed it is dead) and frees the coin for a rebuild.
   */
  unhalt(slot: string, how: "recheck" | "retire"): SlotRecord {
    const record = this.#data.slots[slot];
    if (record?.state !== "halted") throw new JournalError("BAD_TRANSITION", `slot ${slot} is not halted`);
    if (how === "retire") return this.endOffer(slot, "expired", { code: "OPERATOR_RETIRED" });
    return this.#mutate((data) => {
      const r = this.#requireIn(data, slot);
      r.state = "submitted";
      r.stateAt = this.#iso();
      delete r.lastError;
      return r;
    });
  }

  /** A failure before any offer existed (build failed, coin vanished): `error` with a retry time. */
  markError(slot: string, code: string, message: string, retryAt: Date): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
      if (CLAIMING_STATES.includes(record.state)) {
        throw new JournalError("BAD_TRANSITION", `slot ${slot}: use endOffer while an offer is outstanding`);
      }
      record.state = "error";
      record.stateAt = this.#iso();
      record.consecutiveFailures += 1;
      record.lastError = { code, message: redact(message).slice(0, 500), at: this.#iso() };
      record.nextAttemptAt = retryAt.toISOString();
      return record;
    });
  }

  /** No eligible give coin is left for this slot. Terminal (not an error). */
  markDepleted(slot: string, reason: string): SlotRecord {
    return this.#mutate((data) => {
      const record = this.#requireIn(data, slot);
      if (CLAIMING_STATES.includes(record.state)) {
        throw new JournalError("BAD_TRANSITION", `slot ${slot}: cannot deplete while an offer is outstanding`);
      }
      record.state = "depleted";
      record.stateAt = this.#iso();
      record.depletedReason = reason;
      delete record.coinNonce;
      delete record.nextAttemptAt;
      return record;
    });
  }

  /**
   * Re-open depleted slots (the runner calls this once at startup, so a top-up plus a
   * restart revives a slot). Returns the slots re-opened.
   */
  reviveDepleted(): string[] {
    const depleted = Object.values(this.#data.slots).filter((r) => r.state === "depleted").map((r) => r.slot);
    if (depleted.length === 0) return [];
    return this.#mutate((data) => {
      for (const slot of depleted) {
        const record = data.slots[slot]!;
        record.state = "idle";
        record.stateAt = this.#iso();
      }
      return depleted;
    });
  }

  flush(): void {
    this.#mutate(() => undefined);
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

/** The quarantine marker next to a journal (audit C2). */
export const quarantineFile = (file: string): string => `${file}.quarantine`;

/**
 * Open (or create) the journal.
 * - quarantine marker present → `CORRUPT`, every time, until `reset` (audit C2);
 * - missing → fresh, written immediately;
 * - unparseable / invalid → moved to `<file>.corrupt-<stamp>`, a quarantine marker is
 *   written, then `CORRUPT` unless `reset`;
 * - other network or mode → refused and left in place, unless `reset` (moved to
 *   `<file>.superseded-<stamp>`).
 */
export function openJournal(options: OpenJournalOptions): Journal {
  const now = options.now ?? (() => new Date());
  const write = options.write ?? writeAtomic;
  const { file, reset = false } = options;
  const networkId = String(options.networkId ?? "").trim().toLowerCase();
  const mode = String(options.mode ?? "").trim();
  if (file === "" || networkId === "" || mode === "") {
    throw new JournalError("INVALID_ARGUMENT", "journal file, networkId and mode are required");
  }
  mkdirSync(dirname(file), { recursive: true });
  const marker = quarantineFile(file);
  if (existsSync(marker)) {
    if (!reset) {
      throw new JournalError(
        "CORRUPT",
        `journal ${file} is quarantined (${marker}): it was found corrupt earlier. Reconcile the outstanding offers ` +
          "(the kernel's live offers for these makers), then start once with JOURNAL_RESET=true.",
      );
    }
    unlinkSync(marker);
  }
  const fresh = (): Journal => {
    const at = now().toISOString();
    const journal = Journal._create(file, { version: JOURNAL_VERSION, networkId, mode, createdAt: at, updatedAt: at, freshStart: `fresh-${randomUUID().slice(0, 8)}`, slots: {} }, now, write);
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
    if (reset) {
      moveAside(file, "corrupt", now());
      return fresh();
    }
    // Audit F-B18: establish the refusal durably FIRST; only then move the evidence. A
    // failure or crash in between leaves the corrupt file (or the marker) in place, and
    // every later start still refuses.
    write(marker, `${JSON.stringify({ reason: problem, at: now().toISOString() })}\n`);
    const movedAside = moveAside(file, "corrupt", now());
    throw new JournalError(
      "CORRUPT",
      `journal ${file} is unusable (${problem}); moved to ${movedAside} and quarantined. Restore it, or reconcile and start with JOURNAL_RESET=true.`,
      movedAside,
    );
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
  return Journal._create(file, data, now, write);
}
