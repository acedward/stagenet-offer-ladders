// Ladder grid, amounts and configuration.
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import {
  buildSlots,
  formatRatio,
  LadderConfigError,
  levelPrice,
  mulRound,
  parseDecimal,
  parseLadderFile,
  resolveColours,
  toBaseUnits,
} from "../src/ladder.ts";
import { coloursFromDeployments } from "../src/service.ts";
import { COLOUR_A, COLOUR_B, COLOUR_C } from "./helpers.ts";

const base = {
  version: 1,
  networkId: "stagenet",
  mode: "wallet-per-slot",
  tokens: { stkA: { decimals: 6 }, stkB: { decimals: 6 }, stkC: { decimals: 6 } },
  ladders: [
    { id: "AB", give: "stkA", want: "stkB" },
    { id: "BC", give: "stkB", want: "stkC" },
  ],
};

describe("exact decimals", () => {
  test("parseDecimal / mulRound / formatRatio", () => {
    expect(parseDecimal("1.0")).toEqual({ num: 10n, den: 10n });
    expect(parseDecimal("0.2")).toEqual({ num: 2n, den: 10n });
    expect(mulRound(100_000_000n, { num: 76n, den: 90n })).toBe(84_444_444n);
    expect(mulRound(5n, { num: 1n, den: 2n })).toBe(3n); // half-up
    expect(formatRatio({ num: 8n, den: 9n }, 3)).toBe("0.889");
    expect(() => parseDecimal("-1")).toThrow(LadderConfigError);
    expect(() => parseDecimal("1e3")).toThrow(LadderConfigError);
  });

  test("toBaseUnits: whole tokens at 6 decimals", () => {
    expect(toBaseUnits("100", 6)).toBe(100_000_000n);
    expect(toBaseUnits("0.5", 6)).toBe(500_000n);
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(/decimals/);
  });
});

describe("grid (plan: mid 1.0, ±20 %, 10 levels, 100 tokens)", () => {
  test("the 10 prices are 0.800 … 1.200", () => {
    const mid = parseDecimal("1.0");
    const spread = parseDecimal("0.2");
    const prices = Array.from({ length: 10 }, (_, i) => formatRatio(levelPrice(mid, spread, 10, i), 3));
    expect(prices).toEqual(["0.800", "0.844", "0.889", "0.933", "0.978", "1.022", "1.067", "1.111", "1.156", "1.200"]);
  });

  test("slots: ids, give = 100,000,000 base units, want = round(give × price)", () => {
    const slots = buildSlots(parseLadderFile(base));
    expect(slots).toHaveLength(20);
    expect(slots.map((s) => s.id).slice(0, 3)).toEqual(["AB-01", "AB-02", "AB-03"]);
    expect(slots[19]!.id).toBe("BC-10");
    for (const slot of slots) expect(slot.giveAmount).toBe(100_000_000n);
    expect(slots.filter((s) => s.ladder === "AB").map((s) => s.wantAmount)).toEqual([
      80_000_000n,
      84_444_444n,
      88_888_889n,
      93_333_333n,
      97_777_778n,
      102_222_222n,
      106_666_667n,
      111_111_111n,
      115_555_556n,
      120_000_000n,
    ]);
    expect(slots[10]!.giveSymbol).toBe("stkB");
    expect(slots[10]!.wantSymbol).toBe("stkC");
  });

  test("3-level test ladder: 0.8, 1.0, 1.2", () => {
    const slots = buildSlots(parseLadderFile({ ...base, ladders: [{ id: "AB", give: "stkA", want: "stkB", levels: 3 }] }));
    expect(slots.map((s) => s.priceText)).toEqual(["0.800", "1.000", "1.200"]);
    expect(slots.map((s) => s.wantAmount)).toEqual([80_000_000n, 100_000_000n, 120_000_000n]);
  });

  test("different decimals scale the want leg", () => {
    const file = parseLadderFile({ ...base, tokens: { ...base.tokens, stkC: { decimals: 3 } }, ladders: [{ id: "BC", give: "stkB", want: "stkC", levels: 1 }] });
    expect(buildSlots(file)[0]!.wantAmount).toBe(100_000n);
  });

  test("the repository ladder file is the plan's default", () => {
    const file = parseLadderFile(JSON.parse(readFileSync("ladders/stagenet.json", "utf8")));
    const slots = buildSlots(file);
    expect(file.mode).toBe("wallet-per-slot");
    expect(slots).toHaveLength(20);
    expect(slots[0]!.priceText).toBe("0.800");
    expect(slots[9]!.priceText).toBe("1.200");
  });
});

describe("configuration validation", () => {
  test("bad files are refused with a named problem", () => {
    expect(() => parseLadderFile({ ...base, version: 2 })).toThrow(/version/);
    expect(() => parseLadderFile({ ...base, mode: "x" })).toThrow(/mode/);
    expect(() => parseLadderFile({ ...base, ladders: [{ id: "AB", give: "stkA", want: "stkA" }] })).toThrow(/differ/);
    expect(() => parseLadderFile({ ...base, ladders: [{ id: "AB", give: "stkX", want: "stkA" }] })).toThrow(/unknown give/);
    expect(() => parseLadderFile({ ...base, ladders: [{ id: "AB", give: "stkA", want: "stkB", spread: "1" }] })).toThrow(/spread/);
    expect(() => parseLadderFile({ ...base, ladders: [base.ladders[0], base.ladders[0]] })).toThrow(/duplicate/);
    expect(() => parseLadderFile({ ...base, excludeNonces: ["xyz"] })).toThrow(/excludeNonces/);
  });

  test("colours: explicit wins, then the deployments file; missing is an error", () => {
    const file = parseLadderFile({ ...base, tokens: { ...base.tokens, stkA: { decimals: 6, colour: COLOUR_A } } });
    expect(() => resolveColours(file, {})).toThrow(/stkB has no colour/);
    const colours = resolveColours(file, { stkA: "f".repeat(64), stkB: COLOUR_B, stkC: `0x${COLOUR_C}` });
    expect(colours).toEqual({ stkA: COLOUR_A, stkB: COLOUR_B, stkC: COLOUR_C });
  });

  test("coloursFromDeployments reads several plausible shapes", () => {
    expect(coloursFromDeployments({ tokens: { stkA: { colour: COLOUR_A }, stkB: { tokenColor: COLOUR_B } } }, ["stkA", "stkB"])).toEqual({
      stkA: COLOUR_A,
      stkB: COLOUR_B,
    });
    expect(coloursFromDeployments([{ symbol: "stkC", color: `0x${COLOUR_C.toUpperCase()}` }], ["stkC"])).toEqual({ stkC: COLOUR_C });
    expect(coloursFromDeployments({ rows: [{ name: "stkA", tokenType: COLOUR_A, other: "zz" }] }, ["stkA", "stkB"])).toEqual({ stkA: COLOUR_A });
  });
});
