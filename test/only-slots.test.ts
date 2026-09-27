// P12: a staged rollout runs a subset of the ladder slots (`onlySlots`), each with its
// full-ladder definition, so the journal carries over to the full ladder unchanged.
import { describe, expect, test } from "bun:test";

import { buildSlots, LadderConfigError, parseLadderFile } from "../src/ladder.ts";

describe("onlySlots (staged rollout)", () => {
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

  test("a subset keeps each slot's full-ladder level, price and amounts", () => {
    const full = buildSlots(parseLadderFile(base));
    const staged = buildSlots(parseLadderFile({ ...base, onlySlots: ["AB-01", "AB-02", "BC-01"] }));
    expect(staged.map((s) => [s.id, s.priceText, s.wantAmount])).toEqual([
      ["AB-01", "0.800", 80_000_000n],
      ["AB-02", "0.844", 84_444_444n],
      ["BC-01", "0.800", 80_000_000n],
    ]);
    for (const slot of staged) expect(slot).toEqual(full.find((f) => f.id === slot.id)!);
    expect(full).toHaveLength(20);
  });

  test("unknown, duplicate, empty or malformed lists are refused", () => {
    expect(() => buildSlots(parseLadderFile({ ...base, onlySlots: ["AB-11"] }))).toThrow(LadderConfigError);
    expect(() => parseLadderFile({ ...base, onlySlots: ["AB-01", "AB-01"] })).toThrow(LadderConfigError);
    expect(() => parseLadderFile({ ...base, onlySlots: [] })).toThrow(LadderConfigError);
    expect(() => parseLadderFile({ ...base, onlySlots: ["ab-1"] })).toThrow(LadderConfigError);
  });
});
