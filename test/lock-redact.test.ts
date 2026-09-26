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

describe("C4 service lock", () => {
  test("a second concurrent command is refused; release frees it", () => {
    const first = takeServiceLock(dir, "ladder:run");
    expect(() => takeServiceLock(dir, "makers:mint")).toThrow(LockHeldError);
    const holder = JSON.parse(readFileSync(first.path, "utf8"));
    expect(holder).toMatchObject({ command: "ladder:run", pid: process.pid });
    first.release();
    expect(existsSync(first.path)).toBe(false);
    takeServiceLock(dir, "makers:mint").release();
  });

  test("a stale lock is recovered: dead PID on this host, or not touched for too long", () => {
    writeFileSync(join(dir, "service.lock"), JSON.stringify({ pid: 999999, host: "here", command: "ladder:run", at: "x" }));
    const a = takeServiceLock(dir, "ladder:run", { host: "here", isAlive: () => false });
    a.release();
    writeFileSync(join(dir, "service.lock"), JSON.stringify({ pid: 1, host: "other-container", command: "ladder:run", at: "x" }));
    expect(() => takeServiceLock(dir, "makers:mint", { host: "here" })).toThrow(LockHeldError); // fresh, other host
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, "service.lock"), old, old);
    const b = takeServiceLock(dir, "makers:mint", { host: "here" });
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
});
