/**
 * Health and status HTTP endpoints (spec US5).
 *
 * - `GET /health` carries NO data: `200 ok` while the scheduler loop is alive (its last
 *   tick ended within `staleAfterMs`, or the first tick is still running), `503 stale`
 *   otherwise. Suitable for a Compose health check.
 * - `GET /status` is the slot table: per slot the ladder, price, wallet id (never a
 *   secret), state, current offer id, pinned coin (nonce prefix), expiry, remaining
 *   inventory and the last error code. Public data only.
 *
 * @module
 */
import type { Journal, SlotRecord } from "./journal.ts";

export interface StatusSource {
  readonly journal: Journal;
  readonly startedAt: number;
  readonly delivery: "kernel" | "outbox";
  readonly mode: string;
  lastTickEndedAt(): number | undefined;
  inventory(slot: string): { coins: number; value: bigint } | undefined;
  now(): number;
}

export interface StatusRow {
  readonly slot: string;
  readonly ladder: string;
  readonly price: string;
  readonly walletId: string;
  readonly state: SlotRecord["state"];
  readonly stateAt: string;
  readonly offerId: string | null;
  readonly coin: string | null;
  readonly expiresAt: string | null;
  readonly inventory: { coins: number; value: string } | null;
  readonly offersBuilt: number;
  readonly lastError: string | null;
}

export const statusRows = (source: StatusSource): StatusRow[] =>
  source.journal.slots().map((record) => {
    const inv = source.inventory(record.slot);
    return {
      slot: record.slot,
      ladder: record.ladder,
      price: record.price,
      walletId: record.walletId,
      state: record.state,
      stateAt: record.stateAt,
      offerId: record.current?.offerId ?? null,
      coin: record.coinNonce ? `${record.coinNonce.slice(0, 12)}…` : null,
      expiresAt: record.current?.expiresAt ?? null,
      inventory: inv ? { coins: inv.coins, value: inv.value.toString() } : null,
      offersBuilt: record.cycles,
      lastError: record.lastError ? `${record.lastError.code} @ ${record.lastError.at}` : null,
    };
  });

export const isHealthy = (source: StatusSource, staleAfterMs: number): boolean => {
  const last = source.lastTickEndedAt();
  const reference = last ?? source.startedAt;
  // Before the first tick ends, allow a generous window (wallet sync takes minutes).
  const limit = last === undefined ? Math.max(staleAfterMs, 30 * 60 * 1000) : staleAfterMs;
  return source.now() - reference <= limit;
};

export interface StatusServer {
  readonly port: number;
  stop(): Promise<void>;
}

export const startStatusServer = (source: StatusSource, options: { port: number; hostname?: string; staleAfterMs: number }): StatusServer => {
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname ?? "0.0.0.0",
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (url.pathname === "/health") {
        return isHealthy(source, options.staleAfterMs) ? new Response("ok") : new Response("stale", { status: 503 });
      }
      if (url.pathname === "/status") {
        const summary = source.journal.summary();
        return Response.json({
          networkId: source.journal.networkId,
          mode: source.mode,
          delivery: source.delivery,
          now: new Date(source.now()).toISOString(),
          lastTickEndedAt: source.lastTickEndedAt() ? new Date(source.lastTickEndedAt()!).toISOString() : null,
          states: summary.byState,
          offersBuilt: summary.offersBuilt,
          slots: statusRows(source),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port ?? options.port,
    stop: async () => {
      await server.stop(true);
    },
  };
};
