// Audit C4 (service lock) and C16 (redaction).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redact } from "../src/redact.ts";
import { LockHeldError, takeServiceLock } from "../src/service-lock.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o53-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("C4 / F-B25 / F-B26 / F-B27 service lock (heartbeat liveness)", () => {
  const lockFile = () => join(dir, "service.lock");
  const holder = (h: Record<string, unknown>, ageMs = 0) => {
    writeFileSync(lockFile(), JSON.stringify({ pid: 1, host: "ladder", command: "ladder:run", at: "x", ...h }));
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      utimesSync(lockFile(), t, t);
    }
  };

  test("a second concurrent command is refused; release frees it", () => {
    const first = takeServiceLock(dir, "ladder:run");
    expect(() => takeServiceLock(dir, "makers:mint")).toThrow(LockHeldError);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toMatchObject({ command: "ladder:run", pid: process.pid, instance: first.instance });
    first.release();
    expect(existsSync(first.path)).toBe(false);
    takeServiceLock(dir, "makers:mint").release();
  });

  test("F-B25: a LIVE second container (same hostname, PID 1, other instance, fresh heartbeat) is refused", () => {
    holder({ instance: "i-live" }, 10_000);
    expect(() => takeServiceLock(dir, "ladder:run", { host: "ladder", pid: 1, instance: "i-second" })).toThrow(/heartbeat is 10 s old/);
  });

  test("a stale heartbeat (older than 3 × interval) is taken over, whatever the host", () => {
    holder({ instance: "i-dead", host: "elsewhere" }, 120_000);
    const lock = takeServiceLock(dir, "ladder:run", { host: "ladder", pid: 1, instance: "i-new" });
    expect(lock.held()).toBe(true);
    expect(existsSync(`${lockFile()}.takeover`)).toBe(false);
    lock.release();
  });

  test("BREAK_LOCK names one lock and replaces it at once", () => {
    holder({ instance: "i-remote" }, 1_000);
    expect(() => takeServiceLock(dir, "x", { breakInstance: "i-other" })).toThrow(LockHeldError);
    takeServiceLock(dir, "x", { breakInstance: "i-remote" }).release();
  });

  test("F-B26: while another contender holds the takeover file, a takeover is refused and the lock is untouched", () => {
    holder({ instance: "i-stale" }, 120_000);
    writeFileSync(`${lockFile()}.takeover`, JSON.stringify({ instance: "i-contender" }));
    expect(() => takeServiceLock(dir, "x", { instance: "i-me" })).toThrow(/taking it over right now/);
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).instance).toBe("i-stale");
  });

  test("F-B26: a takeover never removes a fresh lock (renewed between the check and the takeover)", () => {
    holder({ instance: "i-stale" }, 120_000);
    const winner = takeServiceLock(dir, "a", { instance: "i-winner" }); // took the stale lock over
    // a slower contender that judged the SAME stale lock now tries: it must refuse, not rename
    expect(() => takeServiceLock(dir, "b", { instance: "i-loser" })).toThrow(LockHeldError);
    expect(winner.held()).toBe(true);
    winner.release();
  });

  test("F-B27: a failed initialisation leaves no lock behind and says so; a partial lock is judged by its age", () => {
    expect(() =>
      takeServiceLock(dir, "x", {
        writeContent: () => {
          throw new Error("ENOSPC");
        },
      }),
    ).toThrow(/cannot initialise .*ENOSPC/);
    expect(existsSync(lockFile())).toBe(false);
    const lock = takeServiceLock(dir, "x");
    lock.release();
    writeFileSync(lockFile(), "{"); // an unreadable file (e.g. from an older version)
    expect(() => takeServiceLock(dir, "x")).toThrow(LockHeldError); // young: refused
    const t = new Date(Date.now() - 120_000);
    utimesSync(lockFile(), t, t);
    takeServiceLock(dir, "x").release(); // old: taken over, restarts are not blocked forever
  });

  test("paused holder: after a takeover its heartbeat reports the loss and its release keeps the new lock", async () => {
    const lost: string[] = [];
    const a = takeServiceLock(dir, "ladder:run", { heartbeatMs: 15, onLost: (p) => lost.push(p) });
    const t = new Date(Date.now() - 120_000);
    utimesSync(a.path, t, t); // A paused: no heartbeat for 2 min
    const b = takeServiceLock(dir, "ladder:run", { staleAfterMs: 60_000 });
    await Bun.sleep(50);
    expect(lost).toEqual([a.path]);
    expect(a.held()).toBe(false);
    a.release();
    expect(b.held()).toBe(true);
    b.release();
  });
});

describe("C16 redaction", () => {
  test("drops mnemonic-like word runs and keyed hex, keeps public ids", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const out = redact(`failed: ${words} at key=${"ab".repeat(32)} offer ${"cd".repeat(32)} seed ${"ef".repeat(64)}`);
    expect(out).not.toContain("abandon ability");
    expect(out).toContain("[REDACTED-WORDS]");
    expect(out).toContain("key=[REDACTED-HEX]");
    expect(out).toContain("cd".repeat(32)); // an offer id is public
    expect(out).not.toContain("ef".repeat(64));
    expect(redact("the wallet sync failed after 30 s")).toBe("the wallet sync failed after 30 s");
  });

  test("F-B23 / F-A22: comma-, JSON- and hyphen-joined phrases and signing-key JSON are redacted", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    for (const joined of [words.join(","), JSON.stringify(words), words.join("-"), words.join(", ")]) {
      const out = redact(`error: ${joined} end`);
      expect(out).toContain("[REDACTED-WORDS]");
      expect(out).not.toContain("absorb");
    }
    const key = `{"tag":"schnorr","value":"${"ab".repeat(32)}"}`;
    expect(redact(`bad key ${key}`)).not.toContain("ab".repeat(32));
    expect(redact("schnorr:" + "cd".repeat(32))).toContain("cd".repeat(32)); // public verifying-key form stays
  });

  test("F-B29: JSON-escaped, `_ . /`-joined and camelCase phrases, and an escaped signing key, are redacted", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    const camel = words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("");
    for (const joined of [words.join("_"), words.join("."), words.join("/"), camel, JSON.stringify(words.join("\n")), words.join("\\n"), words.join("\u0020")]) {
      expect(redact(`x ${joined} y`)).not.toContain("bstract");
    }
    const escapedKey = JSON.stringify(JSON.stringify({ tag: "schnorr", value: "ab".repeat(32) }));
    expect(redact(escapedKey)).not.toContain("ab".repeat(32));
  });

  test("F-B29: a newline-separated phrase inside an error reaches neither stderr nor the JSON result", async () => {
    const { log, printResult } = await import("../src/cli.ts");
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ").join("\n");
    const errs: string[] = [];
    const outs: string[] = [];
    const e = console.error;
    const o = console.log;
    console.error = (m: string) => errs.push(m);
    console.log = (m: string) => outs.push(m);
    try {
      log(`failure: ${phrase}`);
      printResult({ error: `wrapped: ${phrase}`, nested: [{ key: JSON.stringify({ tag: "schnorr", value: "cd".repeat(32) }) }] });
    } finally {
      console.error = e;
      console.log = o;
    }
    expect(errs.join("")).not.toContain("absorb");
    expect(outs.join("")).not.toContain("absorb");
    expect(outs.join("")).not.toContain("cd".repeat(32));
  });

  test("F-B23: the CLI's output boundaries redact (log and printResult)", async () => {
    const { log, printResult } = await import("../src/cli.ts");
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const errs: string[] = [];
    const outs: string[] = [];
    const e = console.error;
    const o = console.log;
    console.error = (m: string) => errs.push(m);
    console.log = (m: string) => outs.push(m);
    try {
      log(`failure: ${words}`);
      printResult({ error: words });
    } finally {
      console.error = e;
      console.log = o;
    }
    expect(errs.join("")).not.toContain("absorb");
    expect(outs.join("")).not.toContain("absorb");
  });
});
