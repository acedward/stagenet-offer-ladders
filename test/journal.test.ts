// Journal: round trip, transitions, corrupt/foreign files, and crash safety (SIGKILL
// during writes).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JournalError, openJournal, type SlotDefinition } from "../src/journal.ts";
import { COLOUR_A, COLOUR_B, hex64 } from "./helpers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o53-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const def = (slot: string, extra: Partial<SlotDefinition> = {}): SlotDefinition => ({
  slot,
  ladder: "AB",
  level: 0,
  walletId: slot,
  giveColour: COLOUR_A,
  wantColour: COLOUR_B,
  giveAmount: "100000000",
  wantAmount: "80000000",
  price: "0.800",
  ...extra,
});

const ref = (slot: string, n: number) => ({
  offerId: hex64(`offer:${slot}:${n}`),
  blobSha256: hex64(`blob:${slot}:${n}`),
  delivery: "outbox" as const,
  coinNonce: hex64(`nonce:${slot}`),
  coinNullifier: hex64(`nullifier:${slot}`),
  coinValue: "100000000",
  giveAmount: "100000000",
  wantAmount: "80000000",
  ttlSec: 3600,
  builtAt: "2026-09-26T12:00:00.000Z",
  expiresAt: "2026-09-26T13:00:00.000Z",
});

const open = (file = join(dir, "state", "j.json"), extra: { reset?: boolean; mode?: string; networkId?: string } = {}) =>
  openJournal({ file, networkId: extra.networkId ?? "stagenet", mode: extra.mode ?? "wallet-per-slot", reset: extra.reset ?? false });

describe("journal round trip and transitions", () => {
  test("a fresh journal is on disk at once; mutations survive a reopen", () => {
    const file = join(dir, "state", "j.json");
    const j = open(file);
    expect(existsSync(file)).toBe(true);
    j.ensureSlot(def("AB-01"));
    j.beginOffer("AB-01", ref("AB-01", 1));
    j.markLive("AB-01");
    const again = open(file);
    const record = again.get("AB-01")!;
    expect(record.state).toBe("live");
    expect(record.current?.offerId).toBe(ref("AB-01", 1).offerId);
    expect(record.coinNonce).toBe(ref("AB-01", 1).coinNonce);
    expect(record.cycles).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).slots["AB-01"].giveAmount).toBe("100000000");
  });

  test("idle → posting → live → expired → posting (same coin) → live → consumed", () => {
    const j = open();
    j.ensureSlot(def("AB-01"));
    j.beginOffer("AB-01", ref("AB-01", 1));
    expect(j.get("AB-01")!.state).toBe("stored");
    j.markLive("AB-01");
    j.endOffer("AB-01", "expired");
    expect(j.get("AB-01")!.coinNonce).toBe(ref("AB-01", 1).coinNonce); // kept for the re-offer
    j.beginOffer("AB-01", ref("AB-01", 2));
    j.markLive("AB-01");
    j.endOffer("AB-01", "consumed", { code: "COIN_SPENT" });
    const record = j.get("AB-01")!;
    expect(record.state).toBe("consumed");
    expect(record.coinNonce).toBeUndefined();
    expect(record.history.map((h) => h.outcome)).toEqual(["expired", "consumed"]);
    expect(record.cycles).toBe(2);
  });

  test("no second offer while live; a coin claimed by another slot is refused", () => {
    const j = open();
    j.ensureSlot(def("AB-01"));
    j.ensureSlot(def("AB-02"));
    j.beginOffer("AB-01", ref("AB-01", 1));
    j.markLive("AB-01");
    expect(() => j.beginOffer("AB-01", ref("AB-01", 2))).toThrow(JournalError);
    expect(() => j.beginOffer("AB-02", { ...ref("AB-02", 1), coinNonce: ref("AB-01", 1).coinNonce })).toThrow(/claimed/);
  });

  test("rejected/error record the code, count failures and carry a retry time", () => {
    const j = open();
    j.ensureSlot(def("AB-01"));
    j.beginOffer("AB-01", ref("AB-01", 1));
    j.endOffer("AB-01", "rejected", { code: "DUPLICATE_MARKERS", message: "409", retryAt: new Date("2026-09-26T12:01:00Z") });
    let record = j.get("AB-01")!;
    expect(record.lastError?.code).toBe("DUPLICATE_MARKERS");
    expect(record.consecutiveFailures).toBe(1);
    expect(record.nextAttemptAt).toBe("2026-09-26T12:01:00.000Z");
    j.markError("AB-01", "BUILD_FAILED", "boom", new Date("2026-09-26T12:03:00Z"));
    record = j.get("AB-01")!;
    expect(record.consecutiveFailures).toBe(2);
    j.beginOffer("AB-01", ref("AB-01", 2));
    j.markLive("AB-01");
    expect(j.get("AB-01")!.consecutiveFailures).toBe(0);
    expect(j.get("AB-01")!.lastError).toBeUndefined();
  });

  test("depleted is terminal until reviveDepleted (startup re-check)", () => {
    const j = open();
    j.ensureSlot(def("AB-01"));
    j.markDepleted("AB-01", "no coin");
    expect(j.get("AB-01")!.state).toBe("depleted");
    expect(j.reviveDepleted()).toEqual(["AB-01"]);
    expect(j.get("AB-01")!.state).toBe("idle");
  });

  test("a slot's definition is fixed for its life", () => {
    const file = join(dir, "state", "j.json");
    open(file).ensureSlot(def("AB-01"));
    expect(() => open(file).ensureSlot(def("AB-01", { wantAmount: "90000000" }))).toThrow(/fixed for its life/);
    expect(() => open(file).ensureSlot(def("AB-01"))).not.toThrow();
  });
});

describe("journal files that must not be adopted", () => {
  test("a torn/corrupt file is moved aside (never overwritten) and the open refused", () => {
    const file = join(dir, "state", "j.json");
    open(file).ensureSlot(def("AB-01"));
    const good = readFileSync(file, "utf8");
    writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
    let error: JournalError | undefined;
    try {
      open(file);
    } catch (e) {
      error = e as JournalError;
    }
    expect(error?.code).toBe("CORRUPT");
    expect(existsSync(error!.movedAside!)).toBe(true);
    expect(readFileSync(error!.movedAside!, "utf8")).toBe(good.slice(0, Math.floor(good.length / 2)));
    // reset starts fresh; the moved-aside copy stays
    const fresh = open(file, { reset: true });
    expect(fresh.slots()).toEqual([]);
  });

  test("a journal for another network or mode is refused and left in place", () => {
    const file = join(dir, "state", "j.json");
    open(file).ensureSlot(def("AB-01"));
    const before = readFileSync(file, "utf8");
    expect(() => open(file, { networkId: "preprod" })).toThrow(/network/);
    expect(() => open(file, { mode: "single-wallet-pinned" })).toThrow(/mode/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("audit C2/C3", () => {
  test("C2: corrupt → refused → restart still refused (quarantine) → explicit reset → starts", () => {
    const file = join(dir, "state", "j.json");
    open(file).ensureSlot(def("AB-01"));
    writeFileSync(file, "{ not json");
    expect(() => open(file)).toThrow(/quarantined/);
    expect(existsSync(`${file}.quarantine`)).toBe(true);
    // restart (the file is gone now): still refused
    expect(() => open(file)).toThrow(/quarantined/);
    expect(() => open(file)).toThrow(/quarantined/);
    const fresh = open(file, { reset: true });
    expect(fresh.slots()).toEqual([]);
    expect(existsSync(`${file}.quarantine`)).toBe(false);
    expect(() => open(file)).not.toThrow();
  });

  test("F-B18: a failure while writing the quarantine marker leaves the corrupt journal in place: still refused", () => {
    const file = join(dir, "state", "j.json");
    open(file).ensureSlot(def("AB-01"));
    writeFileSync(file, "{ torn");
    const failing = (f: string, c: string) => {
      if (f.endsWith(".quarantine")) throw new Error("ENOSPC");
      writeFileSync(f, c);
    };
    expect(() => openJournal({ file, networkId: "stagenet", mode: "wallet-per-slot", write: failing })).toThrow(/ENOSPC/);
    expect(readFileSync(file, "utf8")).toBe("{ torn"); // evidence not moved
    expect(() => open(file)).toThrow(/quarantined|unusable/);
    expect(() => open(file)).toThrow(/quarantined/);
  });

  test("F-B15: a freshly created journal needs an operator acknowledgement; an existing one does not", () => {
    const file = join(dir, "state", "j.json");
    const j = open(file);
    expect(j.needsFreshStartAck).toBe(true);
    j.acknowledgeFreshStart();
    expect(open(file).needsFreshStartAck).toBe(false);
  });

  test("F-A21: a halted slot is recovered only by an explicit operator action (recheck keeps the claim, retire frees it)", () => {
    const j = open();
    j.ensureSlot(def("AB-01"));
    j.beginOffer("AB-01", ref("AB-01", 1));
    j.halt("AB-01", "OFFER_ID_MISMATCH", "x");
    expect(() => j.unhalt("AB-02" as never, "recheck")).toThrow();
    j.unhalt("AB-01", "recheck");
    expect(j.get("AB-01")!.state).toBe("submitted");
    expect(j.claimedNonces().has(ref("AB-01", 1).coinNonce)).toBe(true);
    j.halt("AB-01", "OFFER_ID_MISMATCH", "x");
    j.unhalt("AB-01", "retire");
    expect(j.get("AB-01")!.state).toBe("expired");
    expect(j.get("AB-01")!.history.at(-1)!.code).toBe("OPERATOR_RETIRED");
    expect(j.claimedNonces().size).toBe(0);
  });

  test("C3: a failed write leaves memory unchanged (candidate → persist → commit)", () => {
    let fail = false;
    const file = join(dir, "state", "j.json");
    const j = openJournal({
      file,
      networkId: "stagenet",
      mode: "wallet-per-slot",
      write: (f, c) => {
        if (fail) throw new Error("EIO");
        writeFileSync(f, c);
      },
    });
    j.ensureSlot(def("AB-01"));
    fail = true;
    expect(() => j.beginOffer("AB-01", ref("AB-01", 1))).toThrow(/EIO/);
    expect(j.get("AB-01")!.state).toBe("idle");
    expect(j.get("AB-01")!.current).toBeUndefined();
    expect(j.claimedNonces().size).toBe(0);
    fail = false;
    j.beginOffer("AB-01", ref("AB-01", 1));
    expect(open(file).get("AB-01")!.state).toBe("stored");
  });

  test("a journal written before the state rename (posting) loads as stored", () => {
    const file = join(dir, "state", "j.json");
    const j = open(file);
    j.ensureSlot(def("AB-01"));
    j.beginOffer("AB-01", ref("AB-01", 1));
    writeFileSync(file, readFileSync(file, "utf8").replace('"state": "stored"', '"state": "posting"'));
    expect(open(file).get("AB-01")!.state).toBe("stored");
  });
});

describe("crash safety", () => {
  test("SIGKILL during continuous writes never leaves an unreadable journal (10 kills)", async () => {
    const file = join(dir, "crash", "j.json");
    let lastCycles = -1;
    for (let round = 0; round < 10; round++) {
      const child = Bun.spawn(["bun", "test/fixtures/journal-crash-writer.ts", file], { stdout: "pipe", stderr: "pipe" });
      const reader = child.stdout.getReader();
      await reader.read(); // "ready"
      await Bun.sleep(20 + Math.floor(Math.random() * 120));
      child.kill("SIGKILL");
      await child.exited;
      const j = openJournal({ file, networkId: "stagenet", mode: "single-wallet-pinned" });
      const slots = j.slots();
      expect(slots.map((s) => s.slot).sort()).toEqual(["AB-01", "AB-02", "AB-03"]);
      for (const s of slots) {
        if (s.state === "stored" || s.state === "live") expect(s.current?.offerId).toMatch(/^[0-9a-f]{64}$/);
      }
      const cycles = slots.reduce((sum, s) => sum + s.cycles, 0);
      expect(cycles).toBeGreaterThanOrEqual(lastCycles); // progress is never lost
      lastCycles = cycles;
    }
    expect(lastCycles).toBeGreaterThan(0);
    expect(readdirSync(join(dir, "crash")).filter((n) => n.includes("corrupt"))).toEqual([]);
  }, 60_000);
});
