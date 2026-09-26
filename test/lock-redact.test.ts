// Audit C4 (service lock) and C16 (redaction).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redact } from "../src/redact.ts";
import { LockHeldError, removeStaleLock, takeServiceLock } from "../src/service-lock.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o53-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("C4 / F-B13 / F-A18 service lock", () => {
  const lockFile = () => join(dir, "service.lock");
  const holder = (h: Record<string, unknown>) => writeFileSync(lockFile(), JSON.stringify({ command: "ladder:run", at: "x", ...h }));

  test("a second concurrent command is refused; release frees it", () => {
    const first = takeServiceLock(dir, "ladder:run");
    expect(() => takeServiceLock(dir, "makers:mint")).toThrow(LockHeldError);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toMatchObject({ command: "ladder:run", pid: process.pid, instance: first.instance });
    first.release();
    expect(existsSync(first.path)).toBe(false);
    takeServiceLock(dir, "makers:mint").release();
  });

  test("no age-only takeover: an old lock of a LIVE holder on this host is refused", () => {
    holder({ pid: 4242, host: "here", instance: "i-old" });
    const old = new Date(Date.now() - 24 * 3_600_000);
    utimesSync(lockFile(), old, old);
    expect(() => takeServiceLock(dir, "makers:mint", { host: "here", pid: 1, isAlive: () => true, startTimeOf: () => undefined })).toThrow(LockHeldError);
  });

  test("dead PID on this host → taken over; PID reused (other start time) → taken over", () => {
    holder({ pid: 4242, host: "here", instance: "i-dead" });
    takeServiceLock(dir, "x", { host: "here", pid: 1, isAlive: () => false }).release();
    holder({ pid: 4242, host: "here", instance: "i-reused", startTime: "100" });
    takeServiceLock(dir, "x", { host: "here", pid: 1, isAlive: () => true, startTimeOf: (p) => (p === 4242 ? "999" : "5") }).release();
  });

  test("container restart: same host and PID 1 but another instance id → taken over", () => {
    holder({ pid: 1, host: "ladder", instance: "i-before-oom" });
    const lock = takeServiceLock(dir, "ladder:run", { host: "ladder", pid: 1, instance: "i-after", isAlive: () => true });
    expect(lock.held()).toBe(true);
    lock.release();
  });

  test("another host cannot be checked: refused, unless BREAK_LOCK names that exact instance", () => {
    holder({ pid: 1, host: "other-container", instance: "i-remote" });
    expect(() => takeServiceLock(dir, "x", { host: "here", pid: 1 })).toThrow(/BREAK_LOCK=i-remote/);
    expect(() => takeServiceLock(dir, "x", { host: "here", pid: 1, breakInstance: "i-wrong" })).toThrow(LockHeldError);
    takeServiceLock(dir, "x", { host: "here", pid: 1, breakInstance: "i-remote" }).release();
  });

  test("paused holder: after a takeover its heartbeat reports the loss and its release does not delete the new lock", async () => {
    const lost: string[] = [];
    const a = takeServiceLock(dir, "ladder:run", { heartbeatMs: 10, onLost: (p) => lost.push(p) });
    // B takes over (as the operator allowed with BREAK_LOCK while A was paused)
    const b = takeServiceLock(dir, "ladder:run", { host: "b", pid: 7, breakInstance: a.instance });
    await Bun.sleep(40);
    expect(lost).toEqual([a.path]);
    expect(a.held()).toBe(false);
    a.release();
    expect(existsSync(b.path)).toBe(true);
    expect(b.held()).toBe(true);
    b.release();
  });

  test("two contenders on one stale lock: the second one's stale judgement cannot remove the winner's lock", () => {
    holder({ pid: 4242, host: "here", instance: "i-stale" });
    const winner = takeServiceLock(dir, "a", { host: "here", pid: 1, isAlive: () => false });
    // the loser judged the SAME stale lock earlier and now tries to remove it
    expect(removeStaleLock(lockFile(), "i-stale", "i-loser")).toBe(false);
    expect(winner.held()).toBe(true);
    winner.release();
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
