// 00058 FR-006: `wallets:add` appends fresh makers to an EXISTING secrets file — it keeps
// every old entry's bytes and order, writes a mode-600 backup first, replaces the file
// atomically, refuses collisions, network mismatches, missing and non-canonical files, and
// never prints a mnemonic. Throwaway mnemonics in temp directories only.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkMakers } from "../src/addresses.ts";
import { main } from "../src/cli.ts";
import {
  addMakersToFile,
  backupStamp,
  generateMakers,
  planMakerSlots,
  readMakersFile,
  SecretsFileError,
  writeMakersFileExclusive,
} from "../src/wallets.ts";

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const NOW = new Date("2026-09-29T18:50:12.345Z");

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o58-add-")); // mode 700
  chmodSync(dir, 0o700);
  file = join(dir, "makers.json");
  writeMakersFileExclusive(file, generateMakers("stagenet", planMakerSlots(4, ["AB", "BC"])));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TBILL_PLAN = () => planMakerSlots(9, ["T13", "T26", "T52"]);
/** Every 3-word window of every mnemonic in the file (what the secret scan looks for). */
const windows = (path: string): string[] =>
  readMakersFile(path).makers.flatMap((m) => {
    const words = m.mnemonic.split(" ");
    return words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(" "));
  });

describe("wallets:add — append and preserve", () => {
  test("9 new makers after the 4 old ones; old bytes kept; backup first; modes 600/700; no temp left", () => {
    const oldBytes = readFileSync(file);
    const oldMakers = readMakersFile(file).makers;
    const result = addMakersToFile(file, { networkId: "stagenet", plan: TBILL_PLAN(), now: () => NOW });

    expect(result.before).toEqual({ entries: 4, sha256: sha(oldBytes), bytes: oldBytes.length });
    expect(result.after.entries).toBe(13);
    const newBytes = readFileSync(file);
    expect(result.after.sha256).toBe(sha(newBytes));
    // Byte preservation: the new file starts with the old bytes up to the last old entry.
    const oldText = oldBytes.toString("utf8");
    const preserved = oldText.slice(0, oldText.length - "\n  ]\n}\n".length);
    expect(newBytes.toString("utf8").startsWith(`${preserved},\n    {`)).toBe(true);
    expect(result.preserved).toEqual({ bytes: Buffer.byteLength(preserved), sha256: sha(preserved) });
    expect(sha(newBytes.subarray(0, result.preserved.bytes))).toBe(result.preserved.sha256);
    // Order: old entries first, unchanged; new entries in plan order.
    const merged = readMakersFile(file);
    expect(merged.makers.map((m) => m.slot)).toEqual([
      "AB-01", "AB-02", "BC-01", "BC-02",
      "T13-01", "T13-02", "T13-03", "T26-01", "T26-02", "T26-03", "T52-01", "T52-02", "T52-03",
    ]);
    expect(merged.makers.slice(0, 4)).toEqual([...oldMakers]);
    expect(merged.makers.slice(4).map((m) => [m.ladder, m.level])).toEqual(
      ["T13", "T26", "T52"].flatMap((l) => [0, 1, 2].map((level) => [l, level])),
    );
    // Top-level fields unchanged (networkId, createdAt, derivation).
    const before = JSON.parse(oldText);
    const after = JSON.parse(newBytes.toString("utf8"));
    expect({ ...after, makers: undefined }).toEqual({ ...before, makers: undefined });
    // Fresh, distinct wallets; the wallets:check logic accepts the merged file.
    expect(new Set(merged.makers.map((m) => m.mnemonic)).size).toBe(13);
    const check = checkMakers(merged, undefined);
    expect(check.problems).toEqual([]);
    expect(check.distinctAddresses).toBe(39);
    // Backup: exact old bytes, mode 600, named with the UTC stamp.
    expect(result.backupFile).toBe(`${file}.bak-20260929T185012Z`);
    expect(backupStamp(NOW)).toBe("20260929T185012Z");
    expect(sha(readFileSync(result.backupFile))).toBe(sha(oldBytes));
    expect(lstatSync(result.backupFile).mode & 0o777).toBe(0o600);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).sort()).toEqual(["makers.json", "makers.json.bak-20260929T185012Z"]);
    // The result carries public identities only.
    expect(result.added.map((a) => a.slot)).toEqual(merged.makers.slice(4).map((m) => m.slot));
    const text = JSON.stringify(result);
    for (const w of windows(file)) expect(text).not.toContain(w);
    for (const a of result.added) expect(a.unshieldedAddress.startsWith("mn_addr_stagenet1")).toBe(true);
  });

  test("a second add appends again and keeps the first add's entries too", () => {
    addMakersToFile(file, { networkId: "stagenet", plan: planMakerSlots(3, ["T13"]), now: () => NOW });
    const middle = readFileSync(file);
    const second = addMakersToFile(file, { networkId: "stagenet", plan: planMakerSlots(2, ["T99"]), now: () => new Date(NOW.getTime() + 1000) });
    expect(second.before.sha256).toBe(sha(middle));
    expect(readMakersFile(file).makers.map((m) => m.slot)).toEqual(["AB-01", "AB-02", "BC-01", "BC-02", "T13-01", "T13-02", "T13-03", "T99-01", "T99-02"]);
    expect(readdirSync(dir).filter((f) => f.includes(".bak-"))).toHaveLength(2);
  });
});

describe("wallets:add — refusals change nothing", () => {
  const unchanged = (bytes: Buffer, files: string[] = ["makers.json"]) => {
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(files);
  };

  test("an id that already exists", () => {
    const bytes = readFileSync(file);
    expect(() => addMakersToFile(file, { networkId: "stagenet", plan: [...TBILL_PLAN(), { slot: "AB-02", ladder: "AB", level: 1 }], now: () => NOW })).toThrow(
      /already holds wallet id\(s\) AB-02/,
    );
    try {
      addMakersToFile(file, { networkId: "stagenet", plan: planMakerSlots(2, ["BC"]) });
    } catch (error) {
      expect((error as SecretsFileError).code).toBe("COLLISION");
    }
    unchanged(bytes);
  });

  test("a network mismatch", () => {
    const bytes = readFileSync(file);
    expect(() => addMakersToFile(file, { networkId: "preprod", plan: TBILL_PLAN() })).toThrow(/is for network stagenet, not preprod/);
    unchanged(bytes);
  });

  test("a missing file (nothing is created)", () => {
    const missing = join(dir, "none.json");
    expect(() => addMakersToFile(missing, { networkId: "stagenet", plan: TBILL_PLAN() })).toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
  });

  test("a file not in the canonical form (its bytes could not be kept)", () => {
    const compact = JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(file, compact, { mode: 0o600 });
    const bytes = readFileSync(file);
    expect(() => addMakersToFile(file, { networkId: "stagenet", plan: TBILL_PLAN() })).toThrow(/canonical form/);
    unchanged(bytes);
  });

  test("a directory open to group/others, or a readable file", () => {
    const bytes = readFileSync(file);
    chmodSync(dir, 0o755);
    expect(() => addMakersToFile(file, { networkId: "stagenet", plan: TBILL_PLAN() })).toThrow(/mode 700/);
    chmodSync(dir, 0o700);
    chmodSync(file, 0o644);
    expect(() => addMakersToFile(file, { networkId: "stagenet", plan: TBILL_PLAN() })).toThrow(/chmod 600/);
    chmodSync(file, 0o600);
    unchanged(bytes);
  });

  test("a mnemonic source that repeats an existing wallet", () => {
    const bytes = readFileSync(file);
    const existing = readMakersFile(file).makers[0]!.mnemonic;
    expect(() => addMakersToFile(file, { networkId: "stagenet", plan: TBILL_PLAN(), mnemonicSource: () => existing })).toThrow(/duplicate/);
    unchanged(bytes);
  });

  test("a file changed while wallets:add runs is not replaced (the backup and the change are kept)", () => {
    const original = readFileSync(file);
    const changed = generateMakers("stagenet", planMakerSlots(2, ["ZZ"]));
    let changedBytes: Buffer | undefined;
    expect(() =>
      addMakersToFile(file, {
        networkId: "stagenet",
        plan: TBILL_PLAN(),
        now: () => NOW,
        beforeRename: () => {
          writeFileSync(file, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
          changedBytes = readFileSync(file);
        },
      }),
    ).toThrow(/changed while wallets:add ran/);
    expect(readFileSync(file).equals(changedBytes!)).toBe(true);
    expect(sha(readFileSync(`${file}.bak-20260929T185012Z`))).toBe(sha(original));
    expect(readdirSync(dir).sort()).toEqual(["makers.json", "makers.json.bak-20260929T185012Z"]); // no temp file left
  });

  test("an existing backup name is never overwritten", () => {
    writeFileSync(`${file}.bak-20260929T185012Z`, "older backup", { mode: 0o600 });
    const bytes = readFileSync(file);
    expect(() => addMakersToFile(file, { networkId: "stagenet", plan: TBILL_PLAN(), now: () => NOW })).toThrow(/refusing to overwrite a backup/);
    expect(readFileSync(`${file}.bak-20260929T185012Z`, "utf8")).toBe("older backup");
    unchanged(bytes, ["makers.json", "makers.json.bak-20260929T185012Z"]);
  });
});

describe("wallets:add — the CLI", () => {
  const capture = async (argv: string[]): Promise<{ code: number | Error; out: string }> => {
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    try {
      const code = await main(argv).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      return { code, out: lines.join("\n") };
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  };

  test("prints ids, unshielded addresses, counts and hashes — never a mnemonic; check and addresses pass", async () => {
    const added = await capture(["wallets:add", "--makers-file", file, "--ladders", "T13,T26,T52", "--count", "9", "--network", "stagenet"]);
    expect(added.code).toBe(0);
    const result = JSON.parse(added.out.slice(added.out.indexOf("{"))) as { before: { entries: number }; after: { entries: number }; backupFile: string; added: { slot: string; unshieldedAddress: string }[] };
    expect(result.before.entries).toBe(4);
    expect(result.after.entries).toBe(13);
    expect(result.added.map((a) => a.slot)).toEqual(TBILL_PLAN().map((p) => p.slot));
    expect(Object.keys(result.added[0]!).sort()).toEqual(["slot", "unshieldedAddress"]);
    expect(existsSync(result.backupFile)).toBe(true);

    const publicJson = join(dir, "public.json");
    const addresses = await capture(["wallets:addresses", "--makers-file", file, "--ladder-file", "ladders/stagenet.books.json", "--public-json", publicJson]);
    expect(addresses.code).toBe(0);
    const checked = await capture(["wallets:check", "--makers-file", file, "--public-json", publicJson]);
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('"result": "PASS"');
    const published = JSON.parse(readFileSync(publicJson, "utf8")) as { makers: { slot: string; price: string | null }[] };
    expect(published.makers.find((m) => m.slot === "T26-02")!.price).toBe("0.9905");

    // No 3-word window of any mnemonic (old or new) anywhere in the output or the public file.
    const everything = [added.out, addresses.out, checked.out, readFileSync(publicJson, "utf8")].join("\n");
    const ws = windows(file);
    expect(ws.length).toBe(13 * 22);
    for (const w of ws) expect(everything).not.toContain(w);

    // Running it again is refused: the ids exist.
    const again = await capture(["wallets:add", "--makers-file", file, "--ladders", "T13,T26,T52", "--count", "9", "--network", "stagenet"]);
    expect(again.code).toBeInstanceOf(Error);
    expect(String((again.code as Error).message)).toMatch(/already holds wallet id\(s\) T13-01/);
    expect(readMakersFile(file).makers).toHaveLength(13);
  });

  test("--ladders and --count are required", async () => {
    const missing = await capture(["wallets:add", "--makers-file", file, "--count", "9"]);
    expect(missing.code).toBeInstanceOf(Error);
    expect(String((missing.code as Error).message)).toMatch(/--ladders and --count are required/);
    const uneven = await capture(["wallets:add", "--makers-file", file, "--ladders", "T13,T26", "--count", "3"]);
    expect(String((uneven.code as Error).message)).toMatch(/not a multiple/);
    expect(readdirSync(dir)).toEqual(["makers.json"]);
  });
});
