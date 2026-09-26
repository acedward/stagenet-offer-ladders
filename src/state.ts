/**
 * Private state outside the repository: `$STK_STATE_DIR` (default
 * `$HOME/.stagenet-offer-ladders`), a mode-700 directory holding mode-600 files.
 *
 * - `maintenance/<token>-<verifying-key-prefix>.signing-key.json`: each deployed contract's
 *   maintenance-authority signing key (secret; never printed or committed).
 * - `funding.lock`: taken by every tool that opens the funding wallet, so two of this
 *   repository's processes never run a wallet session on the same mnemonic at once.
 *
 * @module
 */
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export const stateDir = (): string =>
  process.env.STK_STATE_DIR?.trim() || join(homedir(), ".stagenet-offer-ladders");

const ensurePrivateDir = (path: string): void => {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  // On a Docker Desktop bind mount a stat right after mkdir can still see the old
  // "does not exist" entry for a moment; retry briefly before giving up.
  let mode: number | undefined;
  for (let attempt = 0; mode === undefined; attempt++) {
    try {
      mode = statSync(path).mode;
    } catch (error) {
      if (attempt >= 20) throw error;
      Bun.sleepSync(100);
    }
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} must not be accessible by group or others (chmod 700)`);
  }
};

/**
 * Create a new mode-600 file (never overwrites). The content is secret: it is not
 * echoed in any error.
 */
export const writeSecretFile = (path: string, content: string): void => {
  ensurePrivateDir(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    throw new Error(`cannot create secret file ${path} (${code})`);
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (readFileSync(path, "utf8") !== content) throw new Error(`secret file ${path}: read-back differs`);
};

/** A held lock; `release()` removes the lock file. */
export interface Lock {
  readonly path: string;
  release(): void;
}

/**
 * Take `funding.lock` in the state directory, or throw if another process holds it.
 * A lock left by a crash must be removed by hand after checking that no process holds
 * the funding wallet (`ps`, `docker ps`).
 */
export const takeFundingLock = (purpose: string): Lock => {
  const dir = stateDir();
  ensurePrivateDir(dir);
  const path = join(dir, "funding.lock");
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    let holder = "unknown";
    try {
      holder = readFileSync(path, "utf8").trim();
    } catch {
      // unreadable
    }
    throw new Error(
      `the funding wallet is locked by another process (${holder}); if none is running, remove ${path}`,
    );
  }
  writeSync(fd, JSON.stringify({ purpose, pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  closeSync(fd);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
  };
  process.on("exit", release);
  return { path, release };
};
