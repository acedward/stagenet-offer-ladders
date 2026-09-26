// Maker provisioning: DUST registration and inventory mint, idempotence and skip rules
// (fakes; no network).
import { describe, expect, test } from "bun:test";

import { type MakerOps, type MakerRef, type MakerStatus, mintAll, mintDecision, registerDecision, registerDustAll } from "../src/makers.ts";

const TARGET = 1_000_000_000n; // 10 offers × 100 tokens
const MIN_DUST = 10n ** 15n; // 1 DUST

class FakeMaker implements MakerOps {
  status_: MakerStatus;
  registers = 0;
  mints: bigint[] = [];
  closed = 0;
  failMint = false;
  constructor(status: MakerStatus) {
    this.status_ = status;
  }
  async status(): Promise<MakerStatus> {
    return this.status_;
  }
  async registerDust(): Promise<{ txId: string }> {
    this.registers += 1;
    this.status_ = { ...this.status_, nightUtxos: this.status_.nightUtxos.map((u) => ({ ...u, registered: true })) };
    return { txId: `tx-${this.registers}` };
  }
  async mintGive(amount: bigint) {
    if (this.failMint) throw new Error("proof server down");
    this.mints.push(amount);
    this.status_ = { ...this.status_, giveBalance: this.status_.giveBalance + amount };
    return { txHash: "h", blockHeight: 1, status: "SucceedEntirely", coinNonce: "n" };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

const refs = (slots: string[]): MakerRef[] => slots.map((slot) => ({ slot, ladder: slot.slice(0, 2) }));
const status = (extra: Partial<MakerStatus> = {}): MakerStatus => ({ nightUtxos: [], dust: 0n, giveBalance: 0n, ...extra });

describe("decisions", () => {
  test("register: no NIGHT → skip; all registered → skip; otherwise register", () => {
    expect(registerDecision(status())).toBe("skip-no-night");
    expect(registerDecision(status({ nightUtxos: [{ value: 0n, registered: false }] }))).toBe("skip-no-night");
    expect(registerDecision(status({ nightUtxos: [{ value: 5n, registered: true }] }))).toBe("skip-already-registered");
    expect(registerDecision(status({ nightUtxos: [{ value: 5n, registered: true }, { value: 7n, registered: false }] }))).toBe("register");
  });

  test("mint: recorded → skip; already holds the target → skip; no DUST → skip; else mint", () => {
    expect(mintDecision(status({ dust: MIN_DUST }), TARGET, MIN_DUST, true)).toBe("skip-already-minted");
    expect(mintDecision(status({ giveBalance: TARGET, dust: 0n }), TARGET, MIN_DUST)).toBe("skip-already-holds");
    expect(mintDecision(status({ giveBalance: TARGET - 1n, dust: MIN_DUST - 1n }), TARGET, MIN_DUST)).toBe("skip-no-dust");
    expect(mintDecision(status({ dust: MIN_DUST }), TARGET, MIN_DUST)).toBe("mint");
  });
});

describe("register-dust loop", () => {
  test("registers only makers with unregistered NIGHT; a second run is a no-op; one open at a time", async () => {
    const fakes = new Map<string, FakeMaker>([
      ["AB-01", new FakeMaker(status({ nightUtxos: [{ value: 1_000n, registered: false }] }))],
      ["AB-02", new FakeMaker(status())],
      ["BC-01", new FakeMaker(status({ nightUtxos: [{ value: 1_000n, registered: true }] }))],
    ]);
    let open = 0;
    let maxOpen = 0;
    const opener = async (m: MakerRef): Promise<MakerOps> => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      const fake = fakes.get(m.slot)!;
      return { ...fake, status: () => fake.status(), registerDust: () => fake.registerDust(), mintGive: (a) => fake.mintGive(a), close: async () => { open -= 1; await fake.close(); } };
    };
    const sleeps: number[] = [];
    const first = await registerDustAll(refs(["AB-01", "AB-02", "BC-01"]), opener, { staggerMs: 5_000, sleep: async (ms) => { sleeps.push(ms); } });
    expect(first.map((r) => r.action)).toEqual(["registered", "skip-no-night", "skip-already-registered"]);
    expect(first[0]!.detail).toMatchObject({ txId: "tx-1", utxos: 1 });
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(maxOpen).toBe(1);
    const second = await registerDustAll(refs(["AB-01", "AB-02", "BC-01"]), opener);
    expect(second.map((r) => r.action)).toEqual(["skip-already-registered", "skip-no-night", "skip-already-registered"]);
    expect(fakes.get("AB-01")!.registers).toBe(1);
    for (const fake of fakes.values()) expect(fake.closed).toBe(2);
  });

  test("one maker's failure does not stop the others, and its wallet is still closed", async () => {
    const good = new FakeMaker(status({ nightUtxos: [{ value: 1n, registered: false }] }));
    const results = await registerDustAll(refs(["AB-01", "AB-02"]), async (m) => {
      if (m.slot === "AB-01") throw new Error("indexer down");
      return good;
    });
    expect(results.map((r) => r.action)).toEqual(["error", "registered"]);
    expect(results[0]!.error).toContain("indexer down");
    expect(good.closed).toBe(1);
  });
});

describe("mint loop", () => {
  test("mints one inventory coin per eligible maker; skips holders, makers without DUST and recorded ones; re-run is a no-op", async () => {
    const fakes = new Map<string, FakeMaker>([
      ["AB-01", new FakeMaker(status({ dust: MIN_DUST }))],
      ["AB-02", new FakeMaker(status({ dust: MIN_DUST, giveBalance: TARGET }))],
      ["AB-03", new FakeMaker(status({ dust: 0n }))],
      ["AB-04", new FakeMaker(status({ dust: MIN_DUST }))],
    ]);
    const recorded = new Set<string>(["AB-04"]);
    const onMinted: string[] = [];
    const run = () =>
      mintAll(refs(["AB-01", "AB-02", "AB-03", "AB-04"]), async (m) => fakes.get(m.slot)!, TARGET, MIN_DUST, {
        minted: recorded,
        onMinted: (slot) => {
          onMinted.push(slot);
          recorded.add(slot);
        },
      });
    const first = await run();
    expect(first.map((r) => r.action)).toEqual(["minted", "skip-already-holds", "skip-no-dust", "skip-already-minted"]);
    expect(fakes.get("AB-01")!.mints).toEqual([TARGET]);
    expect(onMinted).toEqual(["AB-01"]);
    const second = await run();
    expect(second.map((r) => r.action)).toEqual(["skip-already-minted", "skip-already-holds", "skip-no-dust", "skip-already-minted"]);
    expect(fakes.get("AB-01")!.mints).toEqual([TARGET]);
  });

  test("a failed mint is reported, not recorded, and the next maker still runs", async () => {
    const failing = new FakeMaker(status({ dust: MIN_DUST }));
    failing.failMint = true;
    const ok = new FakeMaker(status({ dust: MIN_DUST }));
    const recorded = new Set<string>();
    const results = await mintAll(refs(["AB-01", "AB-02"]), async (m) => (m.slot === "AB-01" ? failing : ok), TARGET, MIN_DUST, {
      minted: recorded,
      onMinted: (slot) => recorded.add(slot),
    });
    expect(results.map((r) => r.action)).toEqual(["error", "minted"]);
    expect([...recorded]).toEqual(["AB-02"]);
  });
});
