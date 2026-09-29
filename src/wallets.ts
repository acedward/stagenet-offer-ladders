/**
 * Maker wallets: generation, key derivation, the secrets file and public identities.
 *
 * Secrets policy (spec FR-001, FR-007):
 * - mnemonics are generated with a CSPRNG (`@scure/bip39` `generateMnemonic`, 256-bit
 *   entropy → 24 words) and exist only in memory and in the secrets file;
 * - the secrets file (default `$HOME/.stagenet-offer-ladders/makers.json`) lives outside
 *   every repository, in a mode-700 directory, as a mode-600 file; it is written
 *   atomically (temp file + fsync + `link`) and `wallets:generate` NEVER overwrites it:
 *   `link(2)` fails with `EEXIST` if the target exists, so a concurrent writer cannot
 *   clobber it either;
 * - `wallets:add` (00058) is the only writer of an existing file: it appends new makers
 *   after a byte-exact mode-600 backup, keeps every existing entry's bytes and order, and
 *   replaces the file atomically (temp + fsync + `rename`);
 * - nothing in this module prints, logs or returns a mnemonic except `readMakersFile`,
 *   whose callers keep it in memory; error messages never quote file contents.
 *
 * Derivation (the one 00052 proved for the stagenet funding wallet, and the kernel's
 * `*_MNEMONIC` path): BIP-39 seed (64 bytes, empty passphrase) → `HDWallet.fromSeed` →
 * account 0 → roles Zswap / NightExternal / Dust → key index 0.
 * Adapted from 00052's `src/wallet.ts` (same repository, `00052-stagenet-stk-tokens`),
 * itself a port of `acedward/compact-multi-segment-emit` `deploy-tools/wallet.ts`
 * (Apache-2.0).
 *
 * @module
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { DustAddress, MidnightBech32m, ShieldedAddress, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

import {
  deriveWalletKeys as deriveKeysBip39,
  type PublicWalletIdentity,
  publicIdentity as identityFromKeys,
  type WalletKeys,
} from "./wallet.ts";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type { PublicWalletIdentity, WalletKeys } from "./wallet.ts";

/** A fresh 24-word English BIP-39 mnemonic from the platform CSPRNG. */
export const newMnemonic = (): string => generateMnemonic(english, 256);

/** Normalise and validate a mnemonic; the error never quotes it. */
export const normaliseMnemonic = (mnemonic: string): string => {
  const phrase = String(mnemonic).trim().split(/\s+/u).join(" ").toLowerCase();
  const words = phrase === "" ? 0 : phrase.split(" ").length;
  if (![12, 15, 18, 21, 24].includes(words) || !validateMnemonic(phrase, english)) {
    throw new Error("not a valid English BIP-39 mnemonic (word count, word or checksum)");
  }
  return phrase;
};

/**
 * BIP-39 seed → HD account 0 → Zswap / NightExternal / Dust at key 0: 00052's
 * `deriveWalletKeys` (the derivation proven on the stagenet funding wallet), after
 * normalising and validating the phrase.
 */
export const deriveWalletKeys = (mnemonic: string, networkId: string, account = 0): WalletKeys =>
  deriveKeysBip39(normaliseMnemonic(mnemonic), networkId, "bip39", account);

/** Public identity of a wallet: safe to print and record (00052's `publicIdentity`). */
export const publicIdentity = (keys: WalletKeys, networkId: string): PublicWalletIdentity => identityFromKeys(keys, networkId);

/** Derive the public identity and clear the secret keys straight away. */
export const identityOf = (mnemonic: string, networkId: string): PublicWalletIdentity => {
  const keys = deriveWalletKeys(mnemonic, networkId);
  try {
    return publicIdentity(keys, networkId);
  } finally {
    keys.clear();
  }
};

/**
 * Parse all three addresses of an identity with the SDK codecs and check each one names
 * `networkId`. Throws on the first mismatch. Returns the decoded public keys so callers
 * can compare them with the identity's hex keys.
 */
export const verifyIdentityAddresses = (identity: PublicWalletIdentity, networkId: string): void => {
  const unshielded = MidnightBech32m.parse(identity.unshieldedAddress);
  if (unshielded.network !== networkId) throw new Error(`unshielded address network ${String(unshielded.network)} != ${networkId}`);
  unshielded.decode(UnshieldedAddress, networkId);
  const shielded = MidnightBech32m.parse(identity.shieldedAddress);
  if (shielded.network !== networkId) throw new Error(`shielded address network ${String(shielded.network)} != ${networkId}`);
  const decoded = shielded.decode(ShieldedAddress, networkId);
  if (decoded.coinPublicKey.data.toString("hex") !== identity.coinPublicKey) throw new Error("shielded address coin key mismatch");
  if (decoded.encryptionPublicKey.data.toString("hex") !== identity.encryptionPublicKey) {
    throw new Error("shielded address encryption key mismatch");
  }
  const dust = MidnightBech32m.parse(identity.dustAddress);
  if (dust.network !== networkId) throw new Error(`dust address network ${String(dust.network)} != ${networkId}`);
  dust.decode(DustAddress, networkId);
};

// ---------------------------------------------------------------------------
// Funding wallet file (single-wallet mode)
// ---------------------------------------------------------------------------

/**
 * Read and validate a BIP-39 mnemonic from a protected file holding either the bare
 * phrase or a `WALLET="<words>"` line (the owner's `.stagenet`). The file must be a
 * regular mode-600 file; errors never quote its contents. From 00052's `src/wallet.ts`.
 */
export const readMnemonicFile = (path: string): string => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SecretsFileError("MISSING", path, "does not exist or cannot be read");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new SecretsFileError("PERMISSIONS", path, "must be a regular file (not a symlink)");
  if ((stats.mode & 0o077) !== 0) throw new SecretsFileError("PERMISSIONS", path, "must not be accessible by group or others (chmod 600)");
  if (stats.size === 0 || stats.size > 4096) throw new SecretsFileError("INVALID", path, "has an unexpected size");
  const text = readFileSync(path, "utf8");
  const assignment = /^\s*(?:export\s+)?WALLET\s*=\s*(["']?)([^"'\r\n]*)\1\s*$/mu.exec(text);
  try {
    return normaliseMnemonic(assignment ? assignment[2]! : text);
  } catch {
    throw new SecretsFileError("INVALID", path, "does not hold a valid English BIP-39 mnemonic");
  }
};

// ---------------------------------------------------------------------------
// Secrets file
// ---------------------------------------------------------------------------

export const MAKERS_FILE_VERSION = 1 as const;
export const DERIVATION_LABEL = "bip39-seed(empty passphrase)/hd account 0/roles zswap,night-external,dust/key 0";

/** One maker wallet (SECRET: holds the mnemonic). */
export interface MakerSecret {
  readonly slot: string;
  readonly ladder: string;
  /** 0-based ladder level. */
  readonly level: number;
  readonly mnemonic: string;
}

export interface MakersFile {
  readonly version: typeof MAKERS_FILE_VERSION;
  readonly networkId: string;
  readonly createdAt: string;
  readonly derivation: string;
  readonly makers: readonly MakerSecret[];
}

/** A problem with the secrets file. The message never contains file contents. */
export class SecretsFileError extends Error {
  readonly code: "EXISTS" | "PERMISSIONS" | "MISSING" | "INVALID" | "COLLISION" | "NETWORK" | "CHANGED";
  constructor(code: SecretsFileError["code"], path: string, detail: string) {
    super(`secrets file ${path}: ${detail}`);
    this.name = "SecretsFileError";
    this.code = code;
  }
}

export const defaultMakersFile = (): string =>
  process.env["MAKERS_FILE"]?.trim() || join(process.env["HOME"] ?? "/root", ".stagenet-offer-ladders", "makers.json");

/** Create the directory with mode 700 if missing; refuse one that group/others can reach. */
export const ensurePrivateDirectory = (directory: string): void => {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SecretsFileError("PERMISSIONS", directory, "parent must be a real directory (not a symlink)");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new SecretsFileError("PERMISSIONS", directory, `directory mode ${(stats.mode & 0o777).toString(8)} is open to group/others (chmod 700)`);
  }
};

/**
 * Write the secrets file atomically and never over an existing file.
 * temp (O_CREAT|O_EXCL, 0600) → write → fsync → close → link(temp, target) → unlink(temp)
 * → fsync(directory). `link` fails with EEXIST if the target exists, so the call is
 * atomic and non-clobbering; a crash leaves either no target or the complete target.
 */
export const writeMakersFileExclusive = (path: string, data: MakersFile): void => {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  if (existsSync(path)) throw new SecretsFileError("EXISTS", path, "already exists; refusing to overwrite maker wallets");
  const temp = join(directory, `.makers.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SecretsFileError("EXISTS", path, "already exists; refusing to overwrite maker wallets");
      }
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the write already failed */
      }
    }
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort */
    }
  }
  try {
    const dirFd = openSync(directory, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* directory fsync is not supported everywhere; the link is already durable enough */
  }
};

const SLOT = /^[A-Z][A-Z0-9]{0,7}-[0-9]{2}$/u;

/** Read and validate the secrets file (mode 600, directory 700). Keep the result in memory only. */
export const readMakersFile = (path: string): MakersFile => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SecretsFileError("MISSING", path, "does not exist or cannot be read (run wallets:generate first)");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new SecretsFileError("PERMISSIONS", path, "must be a regular file (not a symlink)");
  if ((stats.mode & 0o077) !== 0) throw new SecretsFileError("PERMISSIONS", path, "must not be accessible by group or others (chmod 600)");
  // The directory check is skipped only when the file is bind-mounted on its own
  // (MAKERS_DIR_CHECK=false in compose / the helper): the container's mount point is not the
  // host directory, whose mode 700 the host keeps.
  if (process.env["MAKERS_DIR_CHECK"] !== "false") {
    const dirStats = lstatSync(dirname(path));
    if ((dirStats.mode & 0o077) !== 0) throw new SecretsFileError("PERMISSIONS", dirname(path), "directory must be mode 700");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SecretsFileError("INVALID", path, "is not valid JSON");
  }
  const data = raw as Partial<MakersFile>;
  if (data?.version !== MAKERS_FILE_VERSION || typeof data.networkId !== "string" || !Array.isArray(data.makers)) {
    throw new SecretsFileError("INVALID", path, "is not a makers file of this version");
  }
  const slots = new Set<string>();
  const makers = data.makers.map((maker, index) => {
    if (typeof maker?.slot !== "string" || !SLOT.test(maker.slot)) throw new SecretsFileError("INVALID", path, `makers[${index}].slot is invalid`);
    if (slots.has(maker.slot)) throw new SecretsFileError("INVALID", path, `duplicate slot ${maker.slot}`);
    slots.add(maker.slot);
    if (typeof maker.ladder !== "string" || !maker.slot.startsWith(`${maker.ladder}-`)) {
      throw new SecretsFileError("INVALID", path, `makers[${index}].ladder does not match its slot`);
    }
    if (!Number.isSafeInteger(maker.level) || maker.level < 0) throw new SecretsFileError("INVALID", path, `makers[${index}].level is invalid`);
    let mnemonic: string;
    try {
      mnemonic = normaliseMnemonic(maker.mnemonic);
    } catch {
      throw new SecretsFileError("INVALID", path, `makers[${index}] (${maker.slot}) holds an invalid mnemonic`);
    }
    return { slot: maker.slot, ladder: maker.ladder, level: maker.level, mnemonic };
  });
  if (new Set(makers.map((m) => m.mnemonic)).size !== makers.length) {
    throw new SecretsFileError("INVALID", path, "two slots hold the same wallet (duplicate mnemonic)");
  }
  return {
    version: MAKERS_FILE_VERSION,
    networkId: data.networkId,
    createdAt: String(data.createdAt ?? ""),
    derivation: String(data.derivation ?? DERIVATION_LABEL),
    makers,
  };
};

/** The slots `wallets:generate` creates: `count / ladders.length` levels per ladder. */
export const planMakerSlots = (count: number, ladders: readonly string[]): { slot: string; ladder: string; level: number }[] => {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("--count must be a positive integer");
  if (ladders.length === 0) throw new RangeError("--ladders must name at least one ladder");
  if (new Set(ladders).size !== ladders.length) throw new RangeError("--ladders has duplicates");
  if (count % ladders.length !== 0) throw new RangeError(`--count ${count} is not a multiple of ${ladders.length} ladders`);
  const perLadder = count / ladders.length;
  if (perLadder > 99) throw new RangeError("at most 99 slots per ladder");
  const out: { slot: string; ladder: string; level: number }[] = [];
  for (const ladder of ladders) {
    if (!/^[A-Z][A-Z0-9]{0,7}$/u.test(ladder)) throw new RangeError(`invalid ladder id ${ladder}`);
    for (let level = 0; level < perLadder; level++) {
      out.push({ slot: `${ladder}-${String(level + 1).padStart(2, "0")}`, ladder, level });
    }
  }
  return out;
};

/** Generate a makers file (in memory) with distinct fresh mnemonics. */
export const generateMakers = (
  networkId: string,
  plan: readonly { slot: string; ladder: string; level: number }[],
  mnemonicSource: () => string = newMnemonic,
): MakersFile => {
  const seen = new Set<string>();
  const makers = plan.map((entry) => {
    let mnemonic = mnemonicSource();
    // 256-bit entropy collisions do not happen; the check guards a broken source.
    for (let attempt = 0; seen.has(mnemonic); attempt++) {
      if (attempt >= 3) throw new Error("mnemonic source returned duplicates");
      mnemonic = mnemonicSource();
    }
    seen.add(mnemonic);
    return { ...entry, mnemonic };
  });
  return {
    version: MAKERS_FILE_VERSION,
    networkId,
    createdAt: new Date().toISOString(),
    derivation: DERIVATION_LABEL,
    makers,
  };
};

// ---------------------------------------------------------------------------
// Adding makers to an existing secrets file (00058 FR-006)
// ---------------------------------------------------------------------------

/** sha256 of a file's bytes, hex (safe to print: it names a version of a file, not its contents). */
export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** The serialisation `writeMakersFileExclusive` writes (and `wallets:add` keeps). */
const serialiseMakers = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** How a canonical makers file ends after its last maker entry. */
const MAKERS_TAIL = "\n  ]\n}\n";

/** `20260929T185012Z` */
export const backupStamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[-:]/gu, "");

export interface AddMakersOptions {
  /** The network the new wallets are for; must equal the file's `networkId`. */
  readonly networkId: string;
  /** The wallets to add (`planMakerSlots`): ids, ladders and levels. */
  readonly plan: readonly { slot: string; ladder: string; level: number }[];
  readonly mnemonicSource?: () => string;
  readonly now?: () => Date;
  /** Test hook: runs after the new file is written to its temp name, before the rename. */
  readonly beforeRename?: () => void;
}

/** What `addMakersToFile` did. Public data only: ids, addresses, counts and hashes. */
export interface AddMakersResult {
  readonly makersFile: string;
  readonly backupFile: string;
  readonly networkId: string;
  readonly before: { readonly entries: number; readonly sha256: string; readonly bytes: number };
  readonly after: { readonly entries: number; readonly sha256: string; readonly bytes: number };
  /**
   * The old file's bytes up to the end of its last maker entry, which the new file starts
   * with unchanged (so every old entry keeps its order and bytes).
   */
  readonly preserved: { readonly bytes: number; readonly sha256: string };
  readonly added: readonly (PublicWalletIdentity & { readonly slot: string; readonly ladder: string; readonly level: number })[];
}

const fsyncDirectory = (directory: string): void => {
  try {
    const dirFd = openSync(directory, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* directory fsync is not supported everywhere */
  }
};

/** Write `contents` to a NEW file (O_EXCL, mode 600) and fsync it. */
const writeNewFile = (path: string, contents: Uint8Array | string): void => {
  const fd = openSync(path, "wx", 0o600);
  try {
    if (typeof contents === "string") writeSync(fd, contents);
    else writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Append fresh maker wallets to an EXISTING secrets file (spec FR-006):
 *
 * 1. read and validate the file (`readMakersFile`: mode 600, directory 700, valid mnemonics);
 *    refuse a missing file, a network mismatch, a planned id that already exists, or a file
 *    that is not in the canonical form `wallets:generate` writes (its bytes could not be kept);
 * 2. generate mnemonics distinct from every existing one;
 * 3. write a byte-exact backup `<file>.bak-<UTC stamp>` (mode 600, O_EXCL) and check it;
 * 4. write the merged file to a temp name (600) → fsync → re-check that the original did
 *    not change meanwhile → `rename` over it → fsync the directory;
 * 5. re-read and check: old entries byte-identical (the new file starts with the old bytes
 *    up to the last old entry), new entries appended in plan order, mode 600.
 *
 * Existing entries are never re-serialised from parsed data that could differ: the merged
 * text is checked to start with the old text. Nothing here prints or returns a mnemonic.
 */
export const addMakersToFile = (path: string, options: AddMakersOptions): AddMakersResult => {
  const directory = dirname(path);
  const existing = readMakersFile(path); // MISSING / PERMISSIONS / INVALID
  ensurePrivateDirectory(directory);
  const oldBytes = readFileSync(path);
  const oldText = oldBytes.toString("utf8");
  const oldSha = sha256Hex(oldBytes);
  if (existing.networkId !== options.networkId) {
    throw new SecretsFileError("NETWORK", path, `is for network ${existing.networkId}, not ${options.networkId}`);
  }
  if (existing.makers.length === 0) throw new SecretsFileError("INVALID", path, "holds no makers");
  const raw = JSON.parse(oldText) as { makers: unknown[] } & Record<string, unknown>;
  if (serialiseMakers(raw) !== oldText || !oldText.endsWith(MAKERS_TAIL)) {
    throw new SecretsFileError("INVALID", path, "is not in the canonical form wallets:generate writes; refusing to rewrite it");
  }
  if (options.plan.length === 0) throw new RangeError("nothing to add");
  const planned = new Set<string>();
  for (const entry of options.plan) {
    if (!SLOT.test(entry.slot) || !entry.slot.startsWith(`${entry.ladder}-`)) throw new RangeError(`invalid wallet id ${entry.slot}`);
    if (!Number.isSafeInteger(entry.level) || entry.level < 0) throw new RangeError(`invalid level for ${entry.slot}`);
    if (planned.has(entry.slot)) throw new RangeError(`wallet id ${entry.slot} is planned twice`);
    planned.add(entry.slot);
  }
  const collisions = existing.makers.filter((m) => planned.has(m.slot)).map((m) => m.slot);
  if (collisions.length > 0) {
    throw new SecretsFileError("COLLISION", path, `already holds wallet id(s) ${collisions.join(", ")}; nothing was changed`);
  }
  // Fresh mnemonics, distinct from every existing one and from each other.
  const source = options.mnemonicSource ?? newMnemonic;
  const seen = new Set(existing.makers.map((m) => m.mnemonic));
  const fresh = options.plan.map((entry) => {
    let mnemonic = normaliseMnemonic(source());
    for (let attempt = 0; seen.has(mnemonic); attempt++) {
      if (attempt >= 3) throw new Error("mnemonic source returned a duplicate of an existing or new wallet");
      mnemonic = normaliseMnemonic(source());
    }
    seen.add(mnemonic);
    return { slot: entry.slot, ladder: entry.ladder, level: entry.level, mnemonic };
  });
  const newText = serialiseMakers({ ...raw, makers: [...raw.makers, ...fresh] });
  const preservedText = oldText.slice(0, oldText.length - MAKERS_TAIL.length);
  if (!newText.startsWith(`${preservedText},\n`)) throw new Error("internal: the merged file does not keep the old entries' bytes");

  // Backup first (exact bytes), then the atomic replace.
  const now = (options.now ?? (() => new Date()))();
  const backupFile = `${path}.bak-${backupStamp(now)}`;
  try {
    writeNewFile(backupFile, oldBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SecretsFileError("EXISTS", backupFile, "already exists; refusing to overwrite a backup");
    throw error;
  }
  fsyncDirectory(directory);
  if (sha256Hex(readFileSync(backupFile)) !== oldSha) throw new Error(`backup ${backupFile} does not match the original; nothing was changed`);
  const temp = join(directory, `.makers.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  try {
    writeNewFile(temp, newText);
    options.beforeRename?.();
    if (sha256Hex(readFileSync(path)) !== oldSha) {
      throw new SecretsFileError("CHANGED", path, "changed while wallets:add ran; nothing was replaced (the backup is kept)");
    }
    renameSync(temp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        /* best effort */
      }
    }
  }
  fsyncDirectory(directory);

  // Verify what is on disk now.
  const newBytes = readFileSync(path);
  const merged = readMakersFile(path);
  if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error(`${path} is not mode 600 after the replace`);
  if (!newBytes.toString("utf8").startsWith(`${preservedText},\n`)) throw new Error("the replaced file does not start with the old entries");
  if (merged.makers.length !== existing.makers.length + fresh.length) throw new Error("the replaced file has an unexpected number of makers");
  merged.makers.slice(existing.makers.length).forEach((maker, i) => {
    if (maker.slot !== fresh[i]!.slot || maker.mnemonic !== fresh[i]!.mnemonic) throw new Error(`the replaced file's entry ${maker.slot} is not the one written`);
  });
  return {
    makersFile: path,
    backupFile,
    networkId: existing.networkId,
    before: { entries: existing.makers.length, sha256: oldSha, bytes: oldBytes.length },
    after: { entries: merged.makers.length, sha256: sha256Hex(newBytes), bytes: newBytes.length },
    preserved: { bytes: Buffer.byteLength(preservedText), sha256: sha256Hex(preservedText) },
    added: fresh.map(({ mnemonic, ...entry }) => ({ ...entry, ...identityOf(mnemonic, existing.networkId) })),
  };
};
