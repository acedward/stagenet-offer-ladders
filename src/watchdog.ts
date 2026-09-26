/**
 * Progress watchdog (audit C6): when the scheduler has made no progress (no slot
 * processed, no tick ended) for `limitMs`, log and exit so the container's restart policy
 * recovers the process (hung proofs, wedged websockets, …).
 *
 * @module
 */
export interface WatchdogOptions {
  readonly lastProgress: () => number | undefined;
  readonly startedAt: number;
  readonly limitMs: number;
  readonly onStall: (idleMs: number) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

/** Check once; returns the idle time when stalled, else `undefined`. */
export const checkStall = (options: Pick<WatchdogOptions, "lastProgress" | "startedAt" | "limitMs" | "now">): number | undefined => {
  const now = (options.now ?? Date.now)();
  const idle = now - (options.lastProgress() ?? options.startedAt);
  return idle > options.limitMs ? idle : undefined;
};

export const startWatchdog = (options: WatchdogOptions): { stop(): void } => {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const idle = checkStall(options);
    if (idle !== undefined) {
      fired = true;
      options.onStall(idle);
    }
  }, options.intervalMs ?? 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};
