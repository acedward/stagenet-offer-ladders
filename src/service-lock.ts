/**
 * One exclusive lock per state directory, taken by every command that opens a maker or
 * funding wallet or writes the journal (`ladder:*`, `makers:*`, `offers:settle`,
 * `funding:status`). Audit C4: two processes must never run facades on the same seeds or
 * write the same journal.
 *
 * The lock is `<STATE_DIR>/service.lock` (the helper `scripts/ladder-run.sh` and Compose
 * share that directory). It records PID, host, command and time, and its holder touches it
 * every 30 s. It is STALE, and taken over, when its holder is on this host and the PID is
 * gone, or when it has not been touched for `staleAfterMs` (default 5 min) — which also
 * covers a holder in another container, whose PID cannot be checked.
 *
 * @module
 */
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface ServiceLock {
  readonly path: string;
  release(): void;
}

export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly at: string;
}

export class LockHeldError extends Error {
  readonly holder: LockHolder | undefined;
  constructor(path: string, holder: LockHolder | undefined) {
    super(
      `another process holds ${path} (${holder ? `${holder.command}, pid ${holder.pid} on ${holder.host} since ${holder.at}` : "unreadable"}); ` +
        "stop it first (the ladder service must be stopped before any makers:* command)",
    );
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface TakeLockOptions {
  readonly staleAfterMs?: number;
  readonly now?: () => number;
  readonly heartbeatMs?: number;
  /** For tests: whether a PID on this host is alive. */
  readonly isAlive?: (pid: number) => boolean;
  readonly host?: string;
  readonly pid?: number;
}

export const takeServiceLock = (stateDir: string, command: string, options: TakeLockOptions = {}): ServiceLock => {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "service.lock");
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
  const isAlive = options.isAlive ?? alive;
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: LockHolder | undefined;
      try {
        holder = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
      } catch {
        holder = undefined;
      }
      let ageMs = 0;
      try {
        ageMs = now() - statSync(path).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      const deadHere = holder !== undefined && holder.host === host && !isAlive(holder.pid);
      if (attempt === 0 && (deadHere || ageMs > staleAfterMs)) {
        rmSync(path, { force: true }); // stale: take it over
        continue;
      }
      throw new LockHeldError(path, holder);
    }
    writeSync(fd, JSON.stringify({ pid, host, command, at: new Date(now()).toISOString() } satisfies LockHolder));
    closeSync(fd);
    const heartbeat = setInterval(() => {
      try {
        const t = new Date();
        utimesSync(path, t, t);
      } catch {
        /* released */
      }
    }, options.heartbeatMs ?? 30_000);
    heartbeat.unref?.();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      rmSync(path, { force: true });
    };
    process.on("exit", release);
    return { path, release };
  }
  throw new LockHeldError(path, undefined);
};
