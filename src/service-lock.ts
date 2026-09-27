/**
 * One exclusive lock per state directory, taken by every command that opens a maker or
 * funding wallet or writes the journal (`ladder:*`, `makers:*`, `slots:*`, `offers:settle`,
 * `funding:status`). Audit C4: two processes must never run facades on the same seeds or
 * write the same journal.
 *
 * Liveness is the HEARTBEAT, not the host or PID (audits F-B25 / F-A25: PIDs and hostnames
 * repeat across containers, so they cannot prove a holder dead):
 * - the holder touches `service.lock` every `heartbeatMs` (30 s);
 * - a lock whose heartbeat is older than `3 × heartbeatMs` (90 s) is stale; anything younger
 *   is refused, whoever holds it. A restarted container therefore waits about 90 s;
 * - `BREAK_LOCK=<instance>` still lets an operator replace one named lock at once.
 *
 * Creation is atomic (audit F-B27): the content is written to a private temp file, fsynced,
 * and `link(2)`ed to `service.lock`, so the lock never exists half-written; a failed
 * initialisation leaves nothing behind and says so.
 *
 * Takeover is serialised (audit F-B26): a contender must first create
 * `service.lock.takeover` the same atomic way; inside it, it re-checks that the lock is still
 * the stale one, renames it aside, and creates its own with `link(2)` (which fails, and
 * refuses, if anyone else created one meanwhile). A fresh lock is never removed. A takeover
 * file left by a crash is itself stale after 60 s.
 *
 * The heartbeat and `release` verify the instance id: a holder whose lock was taken over
 * calls `onLost` (default: exit 75) and never unlinks another instance's lock; `held()` lets
 * the scheduler check ownership before it publishes anything.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface ServiceLock {
  readonly path: string;
  readonly instance: string;
  /** Is the lock file still ours? */
  held(): boolean;
  release(): void;
}

export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly at: string;
  readonly instance?: string;
  readonly heartbeatMs?: number;
}

export class LockHeldError extends Error {
  readonly holder: LockHolder | undefined;
  constructor(path: string, holder: LockHolder | undefined, hint = "") {
    super(
      `another process holds ${path} (${holder ? `${holder.command}, pid ${holder.pid} on ${holder.host} since ${holder.at}, instance ${holder.instance ?? "?"}` : "unreadable"}); ` +
        `stop it first (the ladder service must be stopped before any makers:* command)${hint}`,
    );
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

export interface TakeLockOptions {
  readonly heartbeatMs?: number;
  /** Stale after this long without a heartbeat (default 3 × heartbeatMs). */
  readonly staleAfterMs?: number;
  readonly now?: () => number;
  readonly host?: string;
  readonly pid?: number;
  readonly instance?: string;
  /** `BREAK_LOCK`: the instance id of a lock the operator confirmed is dead. */
  readonly breakInstance?: string;
  /** Called when the heartbeat finds the lock replaced (default: log and exit 75). */
  readonly onLost?: (path: string) => void;
  /** For tests: the write of the lock content into its temp file. */
  readonly writeContent?: (fd: number, data: string) => void;
}

const readHolder = (path: string): LockHolder | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockHolder;
  } catch {
    return undefined;
  }
};

const ageOf = (path: string, now: number): number | undefined => {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Create `path` atomically with `data`: temp file (O_EXCL, 0600) → write → fsync → link.
 * Returns false if `path` already exists. Never leaves a partial `path` or a temp file.
 */
export const createAtomically = (path: string, data: string, write: (fd: number, data: string) => void = (fd, d) => void writeSync(fd, d)): boolean => {
  const temp = `${path}.init-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    write(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } catch (error) {
    throw new Error(`cannot initialise ${path}: ${(error as Error).message}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already failing */
      }
    }
    rmSync(temp, { force: true });
  }
};

export const takeServiceLock = (stateDir: string, command: string, options: TakeLockOptions = {}): ServiceLock => {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "service.lock");
  const mutex = `${path}.takeover`;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const staleAfterMs = options.staleAfterMs ?? 3 * heartbeatMs;
  const now = options.now ?? Date.now;
  const me = { host: options.host ?? hostname(), pid: options.pid ?? process.pid, instance: options.instance ?? randomUUID() };
  const breakInstance = options.breakInstance ?? process.env["BREAK_LOCK"]?.trim();
  const content = JSON.stringify({
    pid: me.pid,
    host: me.host,
    command,
    at: new Date(now()).toISOString(),
    instance: me.instance,
    heartbeatMs,
  } satisfies LockHolder);

  let acquired = createAtomically(path, content, options.writeContent);
  if (!acquired) {
    const holder = readHolder(path);
    const age = ageOf(path, now());
    const named = breakInstance !== undefined && breakInstance !== "" && holder?.instance === breakInstance;
    const stale = age !== undefined && age > staleAfterMs;
    if (age !== undefined && !stale && !named) {
      throw new LockHeldError(
        path,
        holder,
        `; its heartbeat is ${Math.round(age / 1000)} s old (stale after ${Math.round(staleAfterMs / 1000)} s)` +
          (holder?.instance ? `; if it is certainly not running, BREAK_LOCK=${holder.instance} replaces it now` : ""),
      );
    }
    // Takeover, serialised by the takeover file.
    if (!createAtomically(mutex, content)) {
      const mutexAge = ageOf(mutex, now());
      if (mutexAge !== undefined && mutexAge > 60_000) rmSync(mutex, { force: true }); // left by a crash
      throw new LockHeldError(path, holder, "; another process is taking it over right now, try again");
    }
    try {
      const again = readHolder(path);
      const againAge = ageOf(path, now());
      const stillStale =
        againAge === undefined || (again?.instance === holder?.instance && (againAge > staleAfterMs || named));
      if (!stillStale) throw new LockHeldError(path, again, "; it was renewed meanwhile");
      if (againAge !== undefined) {
        const aside = `${path}.stale-${me.instance}`;
        renameSync(path, aside);
        rmSync(aside, { force: true });
      }
      acquired = createAtomically(path, content, options.writeContent);
      if (!acquired) throw new LockHeldError(path, readHolder(path), "; another process took it first");
    } finally {
      if (readHolder(mutex)?.instance === me.instance) rmSync(mutex, { force: true });
    }
  }

  const held = (): boolean => readHolder(path)?.instance === me.instance;
  const onLost =
    options.onLost ??
    ((p: string) => {
      console.error(`[${new Date().toISOString()}] fatal: ${p} was taken over by another process; exiting`);
      process.exit(75);
    });
  const heartbeat = setInterval(() => {
    if (!held()) {
      clearInterval(heartbeat);
      onLost(path);
      return;
    }
    try {
      const t = new Date();
      utimesSync(path, t, t);
    } catch {
      /* released */
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (held()) rmSync(path, { force: true }); // never unlink another instance's lock
  };
  process.on("exit", release);
  return { path, instance: me.instance, held, release };
};
