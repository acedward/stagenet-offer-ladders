// Maker wallet generation, the secrets file and address derivation.
// Uses the public BIP-39 all-zero-entropy test vector ("abandon … art"), never a real wallet.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

import { buildPublicMakers, checkMakers, renderPublicMakersMarkdown } from "../src/addresses.ts";
import { parseLadderFile } from "../src/ladder.ts";
import {
  generateMakers,
  identityOf,
  newMnemonic,
  planMakerSlots,
  readMakersFile,
  SecretsFileError,
  verifyIdentityAddresses,
  writeMakersFileExclusive,
} from "../src/wallets.ts";

const VECTOR = `${"abandon ".repeat(23)}art`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o53-wallets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LADDERS = parseLadderFile({
  version: 1,
  networkId: "stagenet",
  mode: "wallet-per-slot",
  tokens: { stkA: { decimals: 6 }, stkB: { decimals: 6 }, stkC: { decimals: 6 } },
  ladders: [
    { id: "AB", give: "stkA", want: "stkB" },
    { id: "BC", give: "stkB", want: "stkC" },
  ],
});

describe("mnemonics and derivation", () => {
  test("newMnemonic: 24 valid English words, fresh each call", () => {
    const a = newMnemonic();
    const b = newMnemonic();
    expect(a.split(" ")).toHaveLength(24);
    expect(validateMnemonic(a, english)).toBe(true);
    expect(a).not.toBe(b);
  });

  test("derivation is deterministic and the addresses parse as stagenet", () => {
    const one = identityOf(VECTOR, "stagenet");
    const two = identityOf(VECTOR, "stagenet");
    expect(one).toEqual(two);
    expect(one.unshieldedAddress.startsWith("mn_addr_stagenet1")).toBe(true);
    expect(one.shieldedAddress.startsWith("mn_shield-addr_stagenet1")).toBe(true);
    expect(one.dustAddress.startsWith("mn_dust_stagenet1")).toBe(true);
    expect(() => verifyIdentityAddresses(one, "stagenet")).not.toThrow();
    expect(() => verifyIdentityAddresses(one, "preprod")).toThrow(/network/);
  });

  test("a different network id changes the address encoding, not the keys", () => {
    const stage = identityOf(VECTOR, "stagenet");
    const pre = identityOf(VECTOR, "preprod");
    expect(pre.coinPublicKey).toBe(stage.coinPublicKey);
    expect(pre.unshieldedAddress).not.toBe(stage.unshieldedAddress);
  });

  test("an invalid mnemonic is refused without quoting it", () => {
    expect(() => identityOf(`${"abandon ".repeat(23)}abandon`, "stagenet")).toThrow(/not a valid English BIP-39/);
    try {
      identityOf(`${"abandon ".repeat(23)}abandon`, "stagenet");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("abandon");
    }
  });
});

describe("slot plan", () => {
  test("20 over AB,BC → AB-01…AB-10, BC-01…BC-10", () => {
    const plan = planMakerSlots(20, ["AB", "BC"]);
    expect(plan).toHaveLength(20);
    expect(plan[0]).toEqual({ slot: "AB-01", ladder: "AB", level: 0 });
    expect(plan[9]).toEqual({ slot: "AB-10", ladder: "AB", level: 9 });
    expect(plan[10]).toEqual({ slot: "BC-01", ladder: "BC", level: 0 });
    expect(plan[19]).toEqual({ slot: "BC-10", ladder: "BC", level: 9 });
  });

  test("bad counts and ladders are refused", () => {
    expect(() => planMakerSlots(21, ["AB", "BC"])).toThrow(/multiple/);
    expect(() => planMakerSlots(0, ["AB"])).toThrow();
    expect(() => planMakerSlots(4, ["AB", "AB"])).toThrow(/duplicates/);
    expect(() => planMakerSlots(2, ["ab"])).toThrow(/invalid ladder/);
  });
});

describe("secrets file", () => {
  test("written with mode 600 in a mode-700 directory, read back identically", () => {
    const file = join(dir, "secrets", "makers.json");
    const data = generateMakers("stagenet", planMakerSlots(4, ["AB", "BC"]));
    writeMakersFileExclusive(file, data);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
    const back = readMakersFile(file);
    expect(back.makers.map((m) => m.slot)).toEqual(["AB-01", "AB-02", "BC-01", "BC-02"]);
    expect(back.makers.map((m) => m.mnemonic)).toEqual(data.makers.map((m) => m.mnemonic));
    // no temp file is left behind
    expect(readdirSync(join(dir, "secrets"))).toEqual(["makers.json"]);
  });

  test("never overwrites an existing file", () => {
    const file = join(dir, "secrets", "makers.json");
    writeMakersFileExclusive(file, generateMakers("stagenet", planMakerSlots(2, ["AB"])));
    const before = readFileSync(file, "utf8");
    const again = generateMakers("stagenet", planMakerSlots(2, ["AB"]));
    expect(() => writeMakersFileExclusive(file, again)).toThrow(SecretsFileError);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "secrets"))).toEqual(["makers.json"]);
  });

  test("refuses a directory open to group/others, and a readable file", () => {
    const open = join(dir, "open");
    const file = join(open, "makers.json");
    writeMakersFileExclusive(file, generateMakers("stagenet", planMakerSlots(1, ["AB"])));
    chmodSync(open, 0o755);
    expect(() => readMakersFile(file)).toThrow(/directory must be mode 700/);
    chmodSync(open, 0o700);
    chmodSync(file, 0o644);
    expect(() => readMakersFile(file)).toThrow(/chmod 600/);
    const other = join(dir, "other");
    writeMakersFileExclusive(join(other, "a.json"), generateMakers("stagenet", planMakerSlots(1, ["AB"])));
    chmodSync(other, 0o750);
    expect(() => writeMakersFileExclusive(join(other, "b.json"), generateMakers("stagenet", planMakerSlots(1, ["AB"])))).toThrow(/chmod 700/);
  });

  test("an invalid mnemonic in the file is reported by slot, not quoted", () => {
    const file = join(dir, "s", "makers.json");
    writeMakersFileExclusive(file, generateMakers("stagenet", planMakerSlots(1, ["AB"]), () => VECTOR));
    const text = readFileSync(file, "utf8").replace("art", "zoo");
    chmodSync(file, 0o600);
    writeFileSync(file, text);
    expect(() => readMakersFile(file)).toThrow(/AB-01/);
    try {
      readMakersFile(file);
    } catch (error) {
      expect((error as Error).message).not.toContain("abandon");
    }
  });

  test("a missing file says to generate first", () => {
    expect(() => readMakersFile(join(dir, "none.json"))).toThrow(/wallets:generate/);
    expect(existsSync(join(dir, "none.json"))).toBe(false);
  });
});

describe("public addresses", () => {
  test("public file carries prices and no mnemonic; check passes; tampering is caught", () => {
    const file = join(dir, "s", "makers.json");
    writeMakersFileExclusive(file, generateMakers("stagenet", planMakerSlots(4, ["AB", "BC"])));
    const makers = readMakersFile(file);
    const published = buildPublicMakers(makers, LADDERS);
    const text = JSON.stringify(published);
    for (const maker of makers.makers) {
      expect(text).not.toContain(maker.mnemonic.split(" ").slice(0, 3).join(" "));
    }
    // AB with 10 levels in the ladder file: AB-01 = 0.800, AB-02 = 0.844
    expect(published.makers.map((m) => m.price)).toEqual(["0.800", "0.844", "0.800", "0.844"]);
    expect(published.makers[0]!.gives).toBe("stkA");
    expect(published.makers[2]!.wants).toBe("stkC");
    const check = checkMakers(makers, published);
    expect(check.problems).toEqual([]);
    expect(check.matchesPublicFile).toBe(true);
    expect(check.distinctAddresses).toBe(12);
    const tampered = { ...published, makers: published.makers.map((m, i) => (i === 1 ? { ...m, unshieldedAddress: published.makers[0]!.unshieldedAddress } : m)) };
    expect(checkMakers(makers, tampered).matchesPublicFile).toBe(false);
    const md = renderPublicMakersMarkdown(published, "test");
    expect(md).toContain("send NIGHT here");
    expect(md).toContain(published.makers[3]!.unshieldedAddress);
  });
});
