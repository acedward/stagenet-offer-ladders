/**
 * The book view of book-ladder slots (00057, spec US5): per `base/quote` pair, the best bid,
 * the best ask and the depth of each side, from the slots that currently hold an offer.
 *
 * Prices are the slots' configured level prices in QUOTE PER BASE (e.g. USDC per stock).
 * Depth counts outstanding offers (`stored`, `submitted`, `live`) and sums their legs: an
 * ask gives base and wants quote, a bid gives quote and wants base. Amounts are base units,
 * plus whole tokens when the token decimals are known. Grid slots (no side) are ignored.
 *
 * Pure: used by `/status` and `offers:verify`.
 *
 * @module
 */
import type { SlotRecord } from "./journal.ts";
import { parseDecimal, ratioLess } from "./ladder.ts";

/** Slot states that hold an offer a taker could take (outbox or kernel). */
export const OUTSTANDING_STATES: readonly SlotRecord["state"][] = ["stored", "submitted", "live"];

export interface BookSide {
  /** Slots configured on this side, and those holding an offer now. */
  readonly levels: number;
  readonly offers: number;
  /** Best outstanding price (lowest ask, highest bid), quote per base; null = none. */
  readonly best: string | null;
  /** Sum over outstanding offers, base units (and whole tokens when decimals are known). */
  readonly base: string;
  readonly quote: string;
  readonly baseTokens?: string;
  readonly quoteTokens?: string;
}

export interface BookSummary {
  readonly pair: string;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  /** True when an outstanding bid is at or above an outstanding ask (never expected). */
  readonly crossed: boolean;
  readonly asks: BookSide;
  readonly bids: BookSide;
}

export type BookRecord = Pick<SlotRecord, "side" | "pair" | "price" | "state" | "giveAmount" | "wantAmount">;

/** `units / 10^decimals` as a plain decimal string without trailing zeros. */
export const formatUnits = (units: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
};

export const bookSummary = (records: readonly BookRecord[], decimals: Readonly<Record<string, number>> = {}): BookSummary[] => {
  const pairs = new Map<string, BookRecord[]>();
  for (const record of records) {
    if (record.side === undefined || record.pair === undefined) continue;
    pairs.set(record.pair, [...(pairs.get(record.pair) ?? []), record]);
  }
  const summaries: BookSummary[] = [];
  for (const [pair, slots] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
    const [baseSymbol, quoteSymbol] = pair.split("/") as [string, string];
    const side = (which: "ask" | "bid"): BookSide => {
      const all = slots.filter((s) => s.side === which);
      const open = all.filter((s) => OUTSTANDING_STATES.includes(s.state));
      let best: string | null = null;
      let base = 0n;
      let quote = 0n;
      for (const slot of open) {
        const better = best === null || (which === "ask" ? ratioLess(parseDecimal(slot.price), parseDecimal(best)) : ratioLess(parseDecimal(best), parseDecimal(slot.price)));
        if (better) best = slot.price;
        // An ask gives base and wants quote; a bid gives quote and wants base.
        base += BigInt(which === "ask" ? slot.giveAmount : slot.wantAmount);
        quote += BigInt(which === "ask" ? slot.wantAmount : slot.giveAmount);
      }
      const baseDecimals = decimals[baseSymbol];
      const quoteDecimals = decimals[quoteSymbol];
      return {
        levels: all.length,
        offers: open.length,
        best,
        base: base.toString(),
        quote: quote.toString(),
        ...(baseDecimals === undefined ? {} : { baseTokens: formatUnits(base, baseDecimals) }),
        ...(quoteDecimals === undefined ? {} : { quoteTokens: formatUnits(quote, quoteDecimals) }),
      };
    };
    const asks = side("ask");
    const bids = side("bid");
    const crossed = asks.best !== null && bids.best !== null && !ratioLess(parseDecimal(bids.best), parseDecimal(asks.best));
    summaries.push({ pair, bestBid: bids.best, bestAsk: asks.best, crossed, asks, bids });
  }
  return summaries;
};
