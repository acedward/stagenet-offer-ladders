// Test fakes: an in-process mock kernel (HTTP), a fake wallet whose builds go through the
// real `buildPinnedOffer` + pinned selector, and a fake clock.
import { createHash } from "node:crypto";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import type { KernelOfferStatus } from "../src/kernel-client.ts";
import { buildPinnedOffer, type BuildOfferArgs, type BuiltOffer, type CoinRef, type OfferWallet } from "../src/offer-builder.ts";
import { PinController } from "../src/pinned-wallet.ts";
import type { Clock, LadderWallet, WalletPort, WalletSnapshot } from "../src/scheduler.ts";

export const hex64 = (seed: string): string => createHash("sha256").update(seed).digest("hex");

export const COLOUR_A = hex64("stkA");
export const COLOUR_B = hex64("stkB");
export const COLOUR_C = hex64("stkC");

export const coin = (type: string, label: string, value: bigint): CoinRef => ({
  type,
  nonce: hex64(`nonce:${label}`),
  value,
  nullifier: hex64(`nullifier:${label}`),
});

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  t: number;
  constructor(start = Date.parse("2026-09-26T12:00:00.000Z")) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

// ---------------------------------------------------------------------------
// Fake wallet: coins in memory; builds go through the REAL builder and pin selector
// ---------------------------------------------------------------------------

/** The payload a fake offer blob carries (a real one is a ledger transaction). */
export interface FakeOfferPayload {
  readonly wallet: string;
  readonly inputs: readonly string[];
  readonly nonce: string;
  readonly give: string;
  readonly giveAmount: string;
  readonly want: string;
  readonly wantAmount: string;
  readonly ttl: string;
  readonly n: number;
}

export const decodeFakeOffer = (blob: string): FakeOfferPayload =>
  JSON.parse(new TextDecoder().decode(OfferFiles.decode(blob))) as FakeOfferPayload;

export class FakeWallet implements LadderWallet {
  readonly walletId: string;
  readonly coins = new Map<string, CoinRef>();
  readonly pins = new PinController();
  builds = 0;
  releases = 0;
  reverts = 0;
  failNextBuild: Error | undefined;
  /** Make the fake SDK ignore the pin (to prove the assertion catches it). */
  ignorePin = false;
  snapshotError: Error | undefined;
  #counter = 0;

  constructor(walletId: string, coins: readonly CoinRef[] = []) {
    this.walletId = walletId;
    for (const c of coins) this.coins.set(c.nonce, c);
  }

  async snapshot(): Promise<WalletSnapshot> {
    if (this.snapshotError) throw this.snapshotError;
    return { spendable: [...this.coins.values()], owned: new Set(this.coins.keys()) };
  }

  offerWallet(): OfferWallet {
    return {
      pins: this.pins,
      initSwap: async (args) => {
        if (this.failNextBuild) {
          const error = this.failNextBuild;
          this.failNextBuild = undefined;
          throw error;
        }
        const available = [...this.coins.values()].map((c) => ({ type: c.type, nonce: c.nonce, value: c.value, mt_index: 0n }));
        const chosen = this.ignorePin
          ? available.filter((c) => c.type === args.giveColour).sort((a, b) => (a.value < b.value ? -1 : 1))[0]
          : this.pins.selector(available as never, args.giveColour, args.giveAmount, { inputFeeOverhead: 0n, outputFeeOverhead: 0n } as never);
        if (chosen === undefined) throw new Error("InsufficientFundsError: pinned coin not available");
        const full = this.coins.get(chosen.nonce)!;
        this.#counter += 1;
        return {
          type: "UNPROVEN_TRANSACTION",
          nullifier: full.nullifier,
          payload: {
            wallet: this.walletId,
            inputs: [full.nullifier],
            nonce: full.nonce,
            give: args.giveColour,
            giveAmount: args.giveAmount.toString(),
            want: args.wantColour,
            wantAmount: args.wantAmount.toString(),
            ttl: args.ttl.toISOString(),
            n: this.#counter,
          } satisfies FakeOfferPayload,
        };
      },
      finalize: async (recipe) => {
        const r = recipe as { payload: FakeOfferPayload };
        return {
          guaranteedOffer: { inputs: r.payload.inputs.map((nullifier) => ({ nullifier })) },
          serialize: () => new TextEncoder().encode(JSON.stringify(r.payload)),
        } as never;
      },
      revert: async () => {
        this.reverts += 1;
      },
    };
  }

  async build(args: BuildOfferArgs): Promise<BuiltOffer> {
    this.builds += 1;
    return await buildPinnedOffer(this.offerWallet(), args);
  }

  async release(): Promise<void> {
    this.releases += 1;
  }

  /** Simulate a fill: the coin is spent; optional change comes back as a new coin. */
  spend(nonce: string, change?: CoinRef): void {
    this.coins.delete(nonce);
    if (change) this.coins.set(change.nonce, change);
  }
}

export class FakeWallets implements WalletPort {
  readonly byId = new Map<string, FakeWallet>();
  constructor(wallets: readonly FakeWallet[]) {
    for (const w of wallets) this.byId.set(w.walletId, w);
  }
  async get(walletId: string): Promise<LadderWallet> {
    const w = this.byId.get(walletId);
    if (!w) throw new Error(`no fake wallet ${walletId}`);
    return w;
  }
}

// ---------------------------------------------------------------------------
// Mock kernel: POST /v1/offers, GET /v1/offers/:hash/status, GET /v1/offers/:hash
// ---------------------------------------------------------------------------

export interface MockOffer {
  readonly offerId: string;
  readonly blob: string;
  readonly nullifiers: readonly string[];
  status: KernelOfferStatus;
  readonly postedAt: number;
}

export type Scripted = { status: number; body: unknown; headers?: Record<string, string> } | "drop";

export class MockKernel {
  readonly offers = new Map<string, MockOffer>();
  /** Responses to serve for the next POSTs, in order, before the normal logic. */
  readonly script: Scripted[] = [];
  /** Every POST body received. */
  readonly posts: string[] = [];
  statusCalls = 0;
  successStatus = 200;
  #server: ReturnType<typeof Bun.serve> | undefined;

  get url(): string {
    return `http://127.0.0.1:${this.#server!.port}`;
  }

  start(): this {
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/offers") {
          const body = (await request.json()) as { offer?: string };
          this.posts.push(body.offer ?? "");
          const scripted = this.script.shift();
          if (scripted === "drop") return new Response(null, { status: 599 });
          if (scripted !== undefined) {
            return new Response(JSON.stringify(scripted.body), { status: scripted.status, headers: scripted.headers ?? {} });
          }
          return this.#accept(body.offer ?? "");
        }
        const match = /^\/v1\/offers\/([0-9a-f]{64})(\/status)?$/u.exec(url.pathname);
        if (request.method === "GET" && match) {
          this.statusCalls += 1;
          const offer = this.offers.get(match[1]!);
          if (match[2]) return Response.json({ offerId: match[1], status: offer?.status ?? "not_found" });
          if (!offer) return Response.json({ error: "NOT_FOUND", offerId: match[1] }, { status: 404 });
          return Response.json({ offerId: offer.offerId, offerBech32: offer.blob, computed: { inputNullifiers: offer.nullifiers, status: offer.status } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return this;
  }

  #accept(blob: string): Response {
    let raw: Uint8Array;
    try {
      raw = OfferFiles.decode(blob);
    } catch {
      return Response.json({ error: "BAD_ENCODING", reason: "not a swapoffer" }, { status: 400 });
    }
    const offerId = OfferFiles.offerId(raw);
    if (this.offers.has(offerId)) return Response.json({ error: "DUPLICATE_OFFER", offerId }, { status: 409 });
    const payload = JSON.parse(new TextDecoder().decode(raw)) as FakeOfferPayload;
    // One live offer per input nullifier (what the plan relies on).
    for (const existing of this.offers.values()) {
      if (existing.status === "live" && existing.nullifiers.some((n) => payload.inputs.includes(n))) {
        return Response.json({ error: "DUPLICATE_MARKERS", offerId, activeOfferId: existing.offerId }, { status: 409 });
      }
    }
    this.offers.set(offerId, { offerId, blob, nullifiers: payload.inputs, status: "live", postedAt: Date.now() });
    return Response.json({ success: true, offerId, result: {} }, { status: this.successStatus });
  }

  /** Live offers per input nullifier (to assert "never two live offers on one coin"). */
  liveByNullifier(): Map<string, number> {
    const out = new Map<string, number>();
    for (const offer of this.offers.values()) {
      if (offer.status !== "live") continue;
      for (const n of offer.nullifiers) out.set(n, (out.get(n) ?? 0) + 1);
    }
    return out;
  }

  async stop(): Promise<void> {
    await this.#server?.stop(true);
  }
}
