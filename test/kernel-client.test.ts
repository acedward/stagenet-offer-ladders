// Kernel client against an in-process mock kernel (real HTTP on an ephemeral port).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import { classifyPost, KernelClient, mapKernelStatus, refusalCode, refusalKind } from "../src/kernel-client.ts";
import { MockKernel } from "./helpers.ts";

const blobOf = (n: number, inputs = [`nullifier-${n}`]): string =>
  OfferFiles.encode(new TextEncoder().encode(JSON.stringify({ inputs, n })));

let kernel: MockKernel;
let sleeps: number[];
let client: KernelClient;

beforeEach(() => {
  kernel = new MockKernel().start();
  sleeps = [];
  client = new KernelClient({
    baseUrl: kernel.url,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    attempts: 4,
    random: () => 0.5,
    sameBlobRetries: 3,
    sameBlobDelayMs: 5_000,
  });
});
afterEach(async () => {
  await kernel.stop();
});

describe("classification (pure)", () => {
  test("status codes and refusal codes", () => {
    expect(classifyPost(200, { success: true })).toBe("accepted");
    expect(classifyPost(201, {})).toBe("accepted");
    expect(classifyPost(409, { error: "DUPLICATE_OFFER" })).toBe("duplicate");
    expect(classifyPost(409, { error: "DUPLICATE_MARKERS" })).toBe("rejected");
    expect(classifyPost(400, { error: "ROOT_UNKNOWN" })).toBe("retry-same");
    expect(classifyPost(400, { error: "UTXO_NOT_LIVE" })).toBe("retry-same");
    expect(classifyPost(400, { error: "BAD_ENCODING" })).toBe("rejected");
    expect(classifyPost(422, { error: "NOT_SPONSORED" })).toBe("rejected");
    expect(classifyPost(429, { error: "RATE_LIMITED" })).toBe("retry-transport");
    expect(classifyPost(503, "down")).toBe("retry-transport");
    expect(refusalCode(400, "plain PROOF_INVALID text")).toBe("PROOF_INVALID");
    expect(refusalCode(502, "")).toBe("502");
    expect(refusalKind(409, "DUPLICATE_MARKERS")).toBe("CONFLICT");
    expect(refusalKind(400, "BAD_ENCODING")).toBe("MALFORMED");
    expect(refusalKind(422, "MALFORMED")).toBe("MALFORMED");
    expect(refusalKind(422, "NOT_SPONSORED")).toBe("NOT_SPONSORED");
    expect(refusalKind(400, "NULLIFIER_SPENT")).toBe("SPENT");
    expect(mapKernelStatus("LIVE")).toBe("live");
    expect(mapKernelStatus("weird")).toBe("unknown");
    expect(mapKernelStatus(undefined)).toBe("unknown");
  });

  test("backoff doubles and is capped", () => {
    const c = new KernelClient({ baseUrl: "http://x", baseDelayMs: 1000, maxDelayMs: 5000, random: () => 0.5 });
    expect([1, 2, 3, 4, 5].map((n) => c.backoffMs(n))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
});

describe("POST /v1/offers against the mock kernel", () => {
  test("200 accept: one attempt, offerId returned", async () => {
    const blob = blobOf(1);
    const outcome = await client.postOffer(blob);
    expect(outcome).toMatchObject({ kind: "accepted", status: 200, duplicate: false, attempts: 1 });
    expect(outcome.kind === "accepted" && outcome.offerId).toBe(OfferFiles.offerId(OfferFiles.decode(blob)));
    expect(kernel.posts).toHaveLength(1);
  });

  test("201 accept is treated like 200", async () => {
    kernel.successStatus = 201;
    expect(await client.postOffer(blobOf(2))).toMatchObject({ kind: "accepted", status: 201 });
  });

  test("409 DUPLICATE_OFFER (lost ack) = accepted duplicate, not retried", async () => {
    const blob = blobOf(3);
    await client.postOffer(blob);
    const again = await client.postOffer(blob);
    expect(again).toMatchObject({ kind: "accepted", duplicate: true, attempts: 1 });
    expect(kernel.posts).toHaveLength(2);
  });

  test("409 conflict (a live offer already spends the coin) is rejected and NEVER retried", async () => {
    await client.postOffer(blobOf(4, ["same-coin"]));
    const conflict = await client.postOffer(blobOf(5, ["same-coin"]));
    expect(conflict).toMatchObject({ kind: "rejected", status: 409, code: "DUPLICATE_MARKERS", refusal: "CONFLICT", attempts: 1 });
    expect(kernel.posts).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  test("422 malformed and 400 BAD_ENCODING are rejected once, never retried", async () => {
    kernel.script.push({ status: 422, body: { error: "MALFORMED", reason: "bad" } });
    expect(await client.postOffer(blobOf(6))).toMatchObject({ kind: "rejected", status: 422, code: "MALFORMED", refusal: "MALFORMED", attempts: 1 });
    expect(await client.postOffer("swapoffer1notreallyanoffer")).toMatchObject({ kind: "rejected", status: 400, code: "BAD_ENCODING", refusal: "MALFORMED", attempts: 1 });
    expect(kernel.posts).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  test("5xx is retried with backoff until it succeeds", async () => {
    kernel.script.push({ status: 503, body: "busy" }, { status: 500, body: { error: "INTERNAL" } });
    const outcome = await client.postOffer(blobOf(7));
    expect(outcome).toMatchObject({ kind: "accepted", attempts: 3 });
    expect(sleeps).toEqual([1000, 2000]);
    expect(kernel.posts).toHaveLength(3);
    expect(new Set(kernel.posts).size).toBe(1); // the SAME blob every time
  });

  test("5xx forever → unavailable after the attempt budget", async () => {
    for (let i = 0; i < 10; i++) kernel.script.push({ status: 502, body: "bad gateway" });
    const outcome = await client.postOffer(blobOf(8));
    expect(outcome).toMatchObject({ kind: "unavailable", status: 502, attempts: 4 });
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test("429 honours Retry-After", async () => {
    kernel.script.push({ status: 429, body: { error: "RATE_LIMITED" }, headers: { "retry-after": "7" } });
    expect(await client.postOffer(blobOf(9))).toMatchObject({ kind: "accepted", attempts: 2 });
    expect(sleeps).toEqual([7000]);
  });

  test("ROOT_UNKNOWN is retried with the same blob, bounded", async () => {
    kernel.script.push({ status: 400, body: { error: "ROOT_UNKNOWN" } }, { status: 400, body: { error: "ROOT_UNKNOWN" } });
    expect(await client.postOffer(blobOf(10))).toMatchObject({ kind: "accepted", attempts: 3 });
    expect(sleeps).toEqual([5000, 5000]);
    for (let i = 0; i < 10; i++) kernel.script.push({ status: 400, body: { error: "ROOT_UNKNOWN" } });
    expect(await client.postOffer(blobOf(11))).toMatchObject({ kind: "unavailable", code: "ROOT_UNKNOWN" });
  });

  test("an unreachable kernel is unavailable, not an exception", async () => {
    await kernel.stop();
    const dead = new KernelClient({ baseUrl: kernel.url, sleep: async () => undefined, attempts: 2 });
    expect(await dead.postOffer(blobOf(12))).toMatchObject({ kind: "unavailable", attempts: 2 });
  });
});

describe("status reads", () => {
  test("live / not_found; transport errors retried then thrown", async () => {
    const blob = blobOf(13);
    const posted = await client.postOffer(blob);
    const offerId = posted.kind === "accepted" ? posted.offerId! : "";
    expect(await client.offerStatus(offerId)).toBe("live");
    kernel.offers.get(offerId)!.status = "consumed";
    expect(await client.offerStatus(offerId)).toBe("consumed");
    expect(await client.offerStatus("0".repeat(64))).toBe("not_found");
    await kernel.stop();
    const dead = new KernelClient({ baseUrl: kernel.url, sleep: async () => undefined, attempts: 2 });
    await expect(dead.offerStatus(offerId)).rejects.toThrow(/unavailable/);
  });
});
