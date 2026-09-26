/**
 * One exclusive lock per state directory, taken by every command that opens a maker or
 * funding wallet or writes the journal (`ladder:*`, `makers:*`, `offers:settle`,
 * `funding:status`). Audit C4: two processes must never run facades on the same seeds or
 * write the same journal.
 *
 * `<STATE_DIR>/service.lock` records PID, host, command, a random per-process INSTANCE id
 * and the process start time. Audits F-B13 / F-A18 (fail closed):
 * - there is NO age-based takeover: a live holder is never displaced, however long it
 *   was paused;
 * - a lock is stale, and taken over, only when its holder is on THIS host and provably
 *   gone: its PID is not running, or the PID now belongs to a different process (another
 *   start time, or our own PID with another instance id, as after a container restart);
 * - a holder on another host cannot be checked: refused, unless the operator names that
 *   exact lock with `BREAK_LOCK=<instance>` after making sure it is not running;
 * - takeover renames the stale file aside and verifies it was the one judged stale, so two
 *   contenders cannot both win or delete each other's fresh lock;
 * - the heartbeat and `release` verify the instance id: a holder that finds its lock
 *   replaced calls `onLost` (default: exit) and never unlinks another instance's lock.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, utimesSync, writeSync } from "node:fs";
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
  readonly startTime?: string;
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Linux process start time (clock ticks since boot, /proc/<pid>/stat field 22), if readable. */
export const processStartTime = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
};

export interface TakeLockOptions {
  readonly heartbeatMs?: number;
  /** For tests. */
  readonly isAlive?: (pid: number) => boolean;
  readonly startTimeOf?: (pid: number) => string | undefined;
  readonly host?: string;
  readonly pid?: number;
  readonly instance?: string;
  /** `BREAK_LOCK`: the instance id of a lock the operator confirmed is dead. */
  readonly breakInstance?: string;
  /** Called when the heartbeat finds the lock replaced (default: log and exit 75). */
  readonly onLost?: (path: string) => void;
}

/** Instances held by THIS process (a second take in the same process is never "stale"). */
const ownInstances = new Set<string>();

const readHolder = (path: string): LockHolder | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockHolder;
  } catch {
    return undefined;
  }
};

/** Is `holder` provably gone? Only decidable for a holder on this host. */
export const holderIsGone = (
  holder: LockHolder,
  me: { host: string; pid: number; instance: string },
  isAlive: (pid: number) => boolean,
  startTimeOf: (pid: number) => string | undefined,
): boolean => {
  if (holder.host !== me.host) return false;
  // Our PID but an instance this process never created: a previous life of the PID (for
  // example PID 1 before a container restart).
  if (holder.pid === me.pid) return holder.instance !== me.instance && !ownInstances.has(holder.instance ?? "");
  if (!isAlive(holder.pid)) return true;
  const now = startTimeOf(holder.pid);
  return holder.startTime !== undefined && now !== undefined && now !== holder.startTime; // PID reused
};

/**
 * Replace a stale lock atomically: rename it aside, check it is the one judged stale
 * (same instance id), and put it back if not (another contender got there first).
 */
export const removeStaleLock = (path: string, staleInstance: string | undefined, ownInstance: string): boolean => {
  const aside = `${path}.stale-${ownInstance}`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // gone meanwhile: the caller simply retries the exclusive create
  }
  const moved = readHolder(aside);
  if (moved?.instance !== staleInstance) {
    try {
      linkSync(aside, path); // restore the fresh lock we displaced (fails if yet another exists)
    } catch {
      /* someone else holds it now; nothing to restore over */
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return true;
};

export const takeServiceLock = (stateDir: string, command: string, options: TakeLockOptions = {}): ServiceLock => {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "service.lock");
  const isAlive = options.isAlive ?? alive;
  const startTimeOf = options.startTimeOf ?? processStartTime;
  const me = { host: options.host ?? hostname(), pid: options.pid ?? process.pid, instance: options.instance ?? randomUUID() };
  const breakInstance = options.breakInstance ?? process.env["BREAK_LOCK"]?.trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(path);
      if (holder === undefined) {
        if (!existsSync(path)) continue;
        throw new LockHeldError(path, undefined, "; the lock file is unreadable: remove it by hand once nothing runs");
      }
      const gone = holderIsGone(holder, me, isAlive, startTimeOf) || (breakInstance !== undefined && breakInstance !== "" && breakInstance === holder.instance);
      if (gone && removeStaleLock(path, holder.instance, me.instance)) continue;
      throw new LockHeldError(
        path,
        holder,
        holder.host !== me.host ? `; it is on another host and cannot be checked: if it is not running, set BREAK_LOCK=${holder.instance ?? "<instance>"} once` : "",
      );
    }
    const content: LockHolder = {
      pid: me.pid,
      host: me.host,
      command,
      at: new Date().toISOString(),
      instance: me.instance,
      ...(startTimeOf(me.pid) !== undefined ? { startTime: startTimeOf(me.pid)! } : {}),
    };
    writeSync(fd, JSON.stringify(content));
    closeSync(fd);
    ownInstances.add(me.instance);
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
    }, options.heartbeatMs ?? 30_000);
    heartbeat.unref?.();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      ownInstances.delete(me.instance);
      if (held()) rmSync(path, { force: true }); // never unlink another instance's lock
    };
    process.on("exit", release);
    return { path, instance: me.instance, held, release };
  }
  throw new LockHeldError(path, readHolder(path));
};
