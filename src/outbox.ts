/**
 * Offer outbox: every built offer's `swapoffer1…` string plus metadata, one file per
 * offer (`<dir>/<offerId>.json`, written atomically).
 *
 * - Outbox mode (`ZSWAP_API` empty): this IS the destination. An entry that the journal
 *   references as a slot's current offer is a live offer waiting for a kernel.
 * - Kernel mode: the same store holds the blob BEFORE it is posted, so a crash between
 *   build and acknowledgement re-posts the identical blob instead of building a second
 *   offer on the same coin.
 *
 * Entries hold public data only (a proven offer is meant to be published).
 *
 * @module
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeAtomic } from "./journal.ts";

export interface OutboxEntry {
  readonly version: 1;
  readonly offerId: string;
  /** `swapoffer1…`. */
  readonly blob: string;
  readonly blobSha256: string;
  readonly networkId: string;
  readonly slot: string;
  readonly walletId: string;
  readonly coinNonce: string;
  readonly coinNullifier: string;
  readonly giveColour: string;
  /** Base units, decimal strings. */
  readonly giveAmount: string;
  readonly wantColour: string;
  readonly wantAmount: string;
  readonly price: string;
  readonly ttlSec: number;
  readonly builtAt: string;
  readonly expiresAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

export const blobSha256 = (blob: string): string => createHash("sha256").update(blob).digest("hex");

export class Outbox {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #path(offerId: string): string {
    if (!HEX64.test(offerId)) throw new Error(`outbox: offerId must be 64 lowercase hex, got ${JSON.stringify(offerId)}`);
    return join(this.dir, `${offerId}.json`);
  }

  /** Store an entry. Idempotent for identical content; a different blob under one id is refused. */
  put(entry: OutboxEntry): void {
    if (!entry.blob.startsWith("swapoffer1")) throw new Error("outbox: blob is not a swapoffer1… string");
    if (blobSha256(entry.blob) !== entry.blobSha256) throw new Error("outbox: blobSha256 does not match the blob");
    const path = this.#path(entry.offerId);
    if (existsSync(path)) {
      const existing = this.get(entry.offerId);
      if (existing?.blobSha256 === entry.blobSha256) return;
      throw new Error(`outbox: ${entry.offerId} already holds a different blob`);
    }
    writeAtomic(path, `${JSON.stringify(entry, null, 2)}\n`);
  }

  get(offerId: string): OutboxEntry | undefined {
    const path = this.#path(offerId);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as OutboxEntry;
  }

  has(offerId: string): boolean {
    return existsSync(this.#path(offerId));
  }

  list(): OutboxEntry[] {
    return readdirSync(this.dir)
      .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
      .map((name) => JSON.parse(readFileSync(join(this.dir, name), "utf8")) as OutboxEntry)
      .sort((a, b) => (a.builtAt === b.builtAt ? a.offerId.localeCompare(b.offerId) : a.builtAt.localeCompare(b.builtAt)));
  }

  /** Remove entries not in `keep` whose file is older than `olderThanMs` (ended offers). */
  prune(keep: ReadonlySet<string>, olderThanMs: number, now: number): string[] {
    const removed: string[] = [];
    for (const name of readdirSync(this.dir)) {
      const match = /^([0-9a-f]{64})\.json$/u.exec(name);
      if (!match || keep.has(match[1]!)) continue;
      const path = join(this.dir, name);
      if (now - statSync(path).mtimeMs < olderThanMs) continue;
      unlinkSync(path);
      removed.push(match[1]!);
    }
    return removed;
  }
}
