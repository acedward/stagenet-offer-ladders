/**
 * Maker wallets: generation, key derivation, the secrets file and public identities.
 *
 * Secrets policy (spec FR-001, FR-007):
 * - mnemonics are generated with a CSPRNG (`@scure/bip39` `generateMnemonic`, 256-bit
 *   entropy → 24 words) and exist only in memory and in the secrets file;
 * - the secrets file (default `$HOME/.stagenet-offer-ladders/makers.json`) lives outside
 *   every repository, in a mode-700 directory, as a mode-600 file; it is written
 *   atomically (temp file + fsync + `link`) and is NEVER overwritten: `link(2)` fails with
 *   `EEXIST` if the target exists, so a concurrent writer cannot clobber it either;
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
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import * as ledger from "@midnightntwrk/ledger-v9";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from "@midnightntwrk/wallet-sdk-address-format";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { createKeystore, type UnshieldedKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Secret key material of a wallet (in memory only; call `clear` when done). */
export interface WalletKeys {
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly unshieldedKeystore: UnshieldedKeystore;
  clear(): void;
}

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

/** BIP-39 seed → HD account 0 → Zswap / NightExternal / Dust at key 0. */
export const deriveWalletKeys = (mnemonic: string, networkId: string, account = 0): WalletKeys => {
  const seed = mnemonicToSeedSync(normaliseMnemonic(mnemonic));
  try {
    const hd = HDWallet.fromSeed(seed);
    if (hd.type !== "seedOk") throw new Error("wallet seed rejected by the HD derivation");
    try {
      const derived = hd.hdWallet
        .selectAccount(account)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
        .deriveKeysAt(0);
      if (derived.type !== "keysDerived") throw new Error("wallet key derivation out of bounds");
      const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
      const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
      const unshieldedKeystore = createKeystore({ kind: "schnorr", secret: derived.keys[Roles.NightExternal] }, networkId);
      for (const key of Object.values(derived.keys)) key.fill(0);
      return {
        shieldedSecretKeys,
        dustSecretKey,
        unshieldedKeystore,
        clear: () => {
          shieldedSecretKeys.clear();
          dustSecretKey.clear();
        },
      };
    } finally {
      hd.hdWallet.clear();
    }
  } finally {
    seed.fill(0);
  }
};

/** Public identity of a wallet: safe to print and record. */
export interface PublicWalletIdentity {
  readonly networkId: string;
  /** Unshielded address: send NIGHT here. */
  readonly unshieldedAddress: string;
  readonly shieldedAddress: string;
  readonly dustAddress: string;
  /** Zswap coin public key, hex. */
  readonly coinPublicKey: string;
  /** Zswap encryption public key, hex. */
  readonly encryptionPublicKey: string;
}

export const publicIdentity = (keys: WalletKeys, networkId: string): PublicWalletIdentity => {
  const coinPublicKey = keys.shieldedSecretKeys.coinPublicKey;
  const encryptionPublicKey = keys.shieldedSecretKeys.encryptionPublicKey;
  const shielded = new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(coinPublicKey, "hex")),
    new ShieldedEncryptionPublicKey(Buffer.from(encryptionPublicKey, "hex")),
  );
  return {
    networkId,
    unshieldedAddress: keys.unshieldedKeystore.getBech32Address().asString(),
    shieldedAddress: MidnightBech32m.encode(networkId, shielded).asString(),
    dustAddress: DustAddress.encodePublicKey(networkId, keys.dustSecretKey.publicKey),
    coinPublicKey,
    encryptionPublicKey,
  };
};

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
  readonly code: "EXISTS" | "PERMISSIONS" | "MISSING" | "INVALID";
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
  const dirStats = lstatSync(dirname(path));
  if ((dirStats.mode & 0o077) !== 0) throw new SecretsFileError("PERMISSIONS", dirname(path), "directory must be mode 700");
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
