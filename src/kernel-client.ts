/**
 * Offer Files kernel client: `POST /v1/offers`, `GET /v1/offers/:hash/status`,
 * `GET /v1/offers/:hash`, with retry and backoff.
 *
 * Response vocabulary (kernel `API.md` @ 67db767):
 * - `200 { success, offerId }` accepted (`201` is treated the same);
 * - `400 { error: CODE }` validation refusal; `ROOT_UNKNOWN` and `UTXO_NOT_LIVE`
 *   self-resolve within a few blocks and are retried with the SAME blob;
 * - `409 DUPLICATE_OFFER` the kernel already holds this exact blob (a lost ack): accepted;
 * - `409 DUPLICATE_MARKERS` / other `409`: a conflict with a live offer;
 * - `413`, `422 NOT_SPONSORED | UNPRICED_TOKEN | PRICE_UNAVAILABLE`: refusals;
 * - `429 RATE_LIMITED`: retried after `Retry-After`;
 * - `5xx`, transport errors: retried with exponential backoff and jitter.
 *
 * A refusal (CONFLICT, MALFORMED, any other 4xx) is NEVER retried with the same blob: it
 * is returned to the caller, which journals it and decides (spec: "a kernel rejection
 * code is journaled and surfaced, and never retried blindly").
 *
 * Adapted in spirit from `zswap-offerfiles-kernel` @ 67db767
 * `deploy/scripts/lib/kernel-api.ts` and `poster-tick.ts` (`refusalCode`,
 * `isRetryablePostError`), Apache-2.0.
 *
 * @module
 */

export type PostDisposition =
  /** 200/201: accepted. */
  | "accepted"
  /** 409 DUPLICATE_OFFER: the kernel already holds this exact blob. */
  | "duplicate"
  /** ROOT_UNKNOWN / UTXO_NOT_LIVE: retry the same blob after a pause. */
  | "retry-same"
  /** 429 / 5xx / transport: the kernel is busy or down; retry with backoff. */
  | "retry-transport"
  /** Any other 4xx: a refusal; never retried blindly. */
  | "rejected";

/** Refusal families used in logs and the journal. */
export type RefusalKind = "CONFLICT" | "MALFORMED" | "SPENT" | "NOT_SPONSORED" | "REFUSED";

/** The kernel's refusal code, from whatever shape the body arrived in. */
export function refusalCode(status: number, body: unknown): string {
  const err = (body as { error?: unknown } | null)?.error ?? body;
  const text = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const match = /\b([A-Z][A-Z0-9_]{3,})\b/u.exec(text ?? "");
  return match?.[1] ?? String(status);
}

export function refusalKind(status: number, code: string): RefusalKind {
  if (code === "NULLIFIER_SPENT" || code === "UTXO_SPENT") return "SPENT";
  if (status === 409 || code === "CONFLICT" || code.startsWith("DUPLICATE")) return "CONFLICT";
  if (status === 422 && (code === "NOT_SPONSORED" || code === "UNPRICED_TOKEN" || code === "PRICE_UNAVAILABLE")) return "NOT_SPONSORED";
  if (status === 400 || status === 413 || status === 422 || code === "MALFORMED") return "MALFORMED";
  return "REFUSED";
}

export function classifyPost(status: number, body: unknown): PostDisposition {
  if (status === 200 || status === 201) return "accepted";
  const code = refusalCode(status, body);
  if (status === 409 && code === "DUPLICATE_OFFER") return "duplicate";
  if (status === 429 || status >= 500) return "retry-transport";
  if (code === "ROOT_UNKNOWN" || code === "UTXO_NOT_LIVE") return "retry-same";
  return "rejected";
}

export type PostOutcome =
  | { readonly kind: "accepted"; readonly status: number; readonly offerId?: string; readonly duplicate: boolean; readonly attempts: number }
  | { readonly kind: "rejected"; readonly status: number; readonly code: string; readonly refusal: RefusalKind; readonly reason: string; readonly attempts: number }
  | { readonly kind: "unavailable"; readonly status?: number; readonly code?: string; readonly error: string; readonly attempts: number };

/** Kernel offer status vocabulary (`not_found` included). */
export type KernelOfferStatus = "live" | "consumed" | "cancelled" | "expired" | "not_found" | "unknown";

export function mapKernelStatus(raw: unknown): KernelOfferStatus {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  return (["live", "consumed", "cancelled", "expired", "not_found"] as const).find((s) => s === value) ?? "unknown";
}

export interface KernelClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Total attempts per call (default 6). */
  readonly attempts?: number;
  /** First backoff (default 1 s), doubled per attempt, capped at `maxDelayMs` (default 30 s). */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Retries of the same blob on ROOT_UNKNOWN / UTXO_NOT_LIVE (default 12, 5 s apart). */
  readonly sameBlobRetries?: number;
  readonly sameBlobDelayMs?: number;
  /** Per-request timeout (default 30 s). */
  readonly timeoutMs?: number;
  readonly random?: () => number;
  readonly log?: (fields: Record<string, unknown>) => void;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterMs?: number;
}

const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

export class KernelClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #attempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #sameBlobRetries: number;
  readonly #sameBlobDelayMs: number;
  readonly #timeoutMs: number;
  readonly #random: () => number;
  readonly #log: (fields: Record<string, unknown>) => void;

  constructor(options: KernelClientOptions) {
    if (!/^https?:\/\//u.test(options.baseUrl)) throw new Error("kernel client: baseUrl must be an http(s) URL");
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#attempts = Math.max(1, options.attempts ?? 6);
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#sameBlobRetries = options.sameBlobRetries ?? 12;
    this.#sameBlobDelayMs = options.sameBlobDelayMs ?? 5_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? (() => undefined);
  }

  /** Backoff before attempt `n + 1` (n ≥ 1): base·2^(n−1), capped, ±25 % jitter. */
  backoffMs(attempt: number): number {
    const raw = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
    return Math.round(raw * (0.75 + 0.5 * this.#random()));
  }

  async #request(path: string, init: RequestInit): Promise<Answer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* the kernel answers some error paths with a bare string */
      }
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return retryAfterMs === undefined ? { status: response.status, body } : { status: response.status, body, retryAfterMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `POST /v1/offers { offer }` with the retry policy above. Never throws for HTTP answers. */
  async postOffer(blob: string): Promise<PostOutcome> {
    let transportFailures = 0;
    let sameBlobRetries = 0;
    let attempts = 0;
    let last: { status?: number; code?: string; error: string } = { error: "not attempted" };
    for (;;) {
      attempts += 1;
      let answer: Answer;
      try {
        answer = await this.#request("/v1/offers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offer: blob }),
        });
      } catch (error) {
        transportFailures += 1;
        last = { error: `transport: ${(error as Error).message}` };
        this.#log({ phase: "post", attempt: attempts, result: "unreachable", detail: last.error });
        if (transportFailures >= this.#attempts) return { kind: "unavailable", error: last.error, attempts };
        await this.#sleep(this.backoffMs(transportFailures));
        continue;
      }
      const disposition = classifyPost(answer.status, answer.body);
      const code = refusalCode(answer.status, answer.body);
      if (disposition === "accepted" || disposition === "duplicate") {
        const offerId = (answer.body as { offerId?: unknown } | null)?.offerId;
        return {
          kind: "accepted",
          status: answer.status,
          duplicate: disposition === "duplicate",
          attempts,
          ...(typeof offerId === "string" ? { offerId: offerId.toLowerCase() } : {}),
        };
      }
      if (disposition === "rejected") {
        const reason = JSON.stringify(answer.body ?? null).slice(0, 400);
        return { kind: "rejected", status: answer.status, code, refusal: refusalKind(answer.status, code), reason, attempts };
      }
      if (disposition === "retry-same") {
        sameBlobRetries += 1;
        last = { status: answer.status, code, error: `${answer.status} ${code}` };
        this.#log({ phase: "post", attempt: attempts, result: "retry-same", status: answer.status, code });
        if (sameBlobRetries > this.#sameBlobRetries) return { kind: "unavailable", status: answer.status, code, error: last.error, attempts };
        await this.#sleep(this.#sameBlobDelayMs);
        continue;
      }
      transportFailures += 1;
      last = { status: answer.status, code, error: `${answer.status} ${code}` };
      this.#log({ phase: "post", attempt: attempts, result: "retry", status: answer.status, code });
      if (transportFailures >= this.#attempts) return { kind: "unavailable", status: answer.status, code, error: last.error, attempts };
      await this.#sleep(Math.max(answer.retryAfterMs ?? 0, this.backoffMs(transportFailures)));
    }
  }

  /** `GET /v1/offers/:hash/status`. Retries transport/5xx/429; throws when exhausted. */
  async offerStatus(offerId: string): Promise<KernelOfferStatus> {
    if (!/^[0-9a-f]{64}$/u.test(offerId)) throw new Error("offerStatus: offerId must be 64 lowercase hex");
    let failures = 0;
    for (;;) {
      let answer: Answer | undefined;
      let error: string | undefined;
      try {
        answer = await this.#request(`/v1/offers/${offerId}/status`, { method: "GET" });
      } catch (e) {
        error = (e as Error).message;
      }
      if (answer !== undefined && answer.status === 200) return mapKernelStatus((answer.body as { status?: unknown } | null)?.status);
      if (answer !== undefined && answer.status === 404) return "not_found";
      if (answer !== undefined && answer.status < 500 && answer.status !== 429) {
        throw new Error(`GET /v1/offers/${offerId}/status → ${answer.status}: ${JSON.stringify(answer.body).slice(0, 200)}`);
      }
      failures += 1;
      if (failures >= this.#attempts) throw new Error(`GET /v1/offers/${offerId}/status unavailable: ${error ?? answer?.status}`);
      await this.#sleep(Math.max(answer?.retryAfterMs ?? 0, this.backoffMs(failures)));
    }
  }

  /** `GET /v1/offers/:hash` (the kernel's view, incl. `computed.inputNullifiers`). */
  async getOffer(offerId: string): Promise<{ status: number; body: unknown }> {
    const answer = await this.#request(`/v1/offers/${offerId}`, { method: "GET" });
    return { status: answer.status, body: answer.body };
  }
}
