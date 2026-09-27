/**
 * Offline verification of the service's current offers (plan P3, T3): decode every
 * current offer from the outbox and check it against the journal and the ladder grid.
 *
 * Per offer: exactly one input, equal to the pinned coin's nullifier, nothing fallible;
 * gives exactly `+give` of the give colour and wants exactly `−want` of the want colour
 * (the grid amounts); the TTL recorded; the offer id is the content hash. Across offers:
 * ids, pinned coins and nullifiers are all distinct; pinned coins are in the pool and are
 * not reserves.
 *
 * With the ladder file's slots (00057): every journal slot's wallet, colours and amounts
 * must equal the file's; a book offer's legs must not trade below its level price (an ask
 * receives at least `price × give`, a bid pays at most `price` per base unit); and per pair
 * the best outstanding ask must be above the best bid (`books`).
 *
 * @module
 */
import { bookSummary, type BookSummary } from "./book.ts";
import type { Journal, SlotDefinition } from "./journal.ts";
import { parseDecimal } from "./ladder.ts";
import { inspectOffer } from "./offer-inspect.ts";
import type { Outbox } from "./outbox.ts";

/** Does an offer with these amounts trade at or better than its level, for the maker? */
export const withinLevel = (
  side: "ask" | "bid",
  price: string,
  giveAmount: bigint,
  wantAmount: bigint,
  decimals: { base: number; quote: number },
): boolean => {
  const p = parseDecimal(price);
  // Compare in whole-token terms: quote/base = (quoteUnits / 10^qd) / (baseUnits / 10^bd).
  const [baseUnits, quoteUnits] = side === "ask" ? [giveAmount, wantAmount] : [wantAmount, giveAmount];
  const lhs = quoteUnits * 10n ** BigInt(decimals.base) * p.den; // offer's quote/base, scaled
  const rhs = p.num * baseUnits * 10n ** BigInt(decimals.quote);
  // An ask must receive at least its price; a bid must pay at most its price.
  return side === "ask" ? lhs >= rhs : lhs <= rhs;
};

export interface OfferCheck {
  readonly slot: string;
  readonly side?: "ask" | "bid";
  readonly pair?: string;
  readonly price?: string;
  readonly state: string;
  readonly offerId: string;
  readonly coinNonce: string;
  readonly coinNullifier: string;
  readonly gives: readonly { token: string; amount: string; type: string }[];
  readonly wants: readonly { token: string; amount: string; type: string }[];
  readonly ttl: string | undefined;
  readonly expiresAt: string;
  readonly bytes: number;
  readonly problems: readonly string[];
}

export interface VerifyResult {
  readonly pass: boolean;
  readonly offers: readonly OfferCheck[];
  /** Per book pair (00057): best bid, best ask, depth, crossed. */
  readonly books: readonly BookSummary[];
  /** Ladder-file slots without a current offer (e.g. `depleted`): reported, not a failure. */
  readonly withoutOffer: readonly { slot: string; state: string }[];
  readonly problems: readonly string[];
}

export const verifyCurrentOffers = (
  journal: Journal,
  outbox: Outbox,
  options: {
    pool?: ReadonlySet<string>;
    reserves?: ReadonlySet<string>;
    ttlToleranceMs?: number;
    /** The ladder file's slots: definitions must match the journal's (00057). */
    slots?: readonly SlotDefinition[];
    /** Token decimals by symbol (book price checks and depth in whole tokens). */
    tokenDecimals?: Readonly<Record<string, number>>;
  } = {},
): VerifyResult => {
  const offers: OfferCheck[] = [];
  const problems: string[] = [];
  const withoutOffer: { slot: string; state: string }[] = [];
  const tolerance = options.ttlToleranceMs ?? 120_000;
  const decimals = options.tokenDecimals ?? {};
  if (options.slots !== undefined) {
    const configured = new Map(options.slots.map((s) => [s.slot, s]));
    for (const record of journal.slots()) {
      const def = configured.get(record.slot);
      if (def === undefined) {
        problems.push(`${record.slot}: in the journal but not in the ladder file`);
        continue;
      }
      for (const key of ["walletId", "giveColour", "wantColour", "giveAmount", "wantAmount"] as const) {
        if (record[key] !== def[key]) problems.push(`${record.slot}: journal ${key}=${record[key]}, ladder file ${def[key]}`);
      }
    }
    for (const def of options.slots) {
      const record = journal.get(def.slot);
      if (record === undefined) problems.push(`${def.slot}: in the ladder file but not in the journal`);
      else if (!record.current) withoutOffer.push({ slot: def.slot, state: record.state });
    }
  }
  for (const record of journal.slots()) {
    if (!record.current) continue;
    const current = record.current;
    const entry = outbox.get(current.offerId);
    const own: string[] = [];
    if (entry === undefined) {
      problems.push(`${record.slot}: outbox has no entry ${current.offerId}`);
      continue;
    }
    const inspection = inspectOffer(entry.blob);
    if (inspection.offerId !== current.offerId) own.push(`offer id ${inspection.offerId} != journal ${current.offerId}`);
    if (inspection.inputNullifiers.length !== 1 || inspection.inputNullifiers[0] !== current.coinNullifier) {
      own.push(`inputs [${inspection.inputNullifiers.join(", ")}] != [${current.coinNullifier}]`);
    }
    if (inspection.fallibleInputs !== 0) own.push(`${inspection.fallibleInputs} fallible input(s)`);
    const give = inspection.gives.filter((leg) => leg.token === record.giveColour);
    const want = inspection.wants.filter((leg) => leg.token === record.wantColour);
    if (inspection.gives.length !== 1 || give.length !== 1 || give[0]!.amount !== record.giveAmount) {
      own.push(`gives ${JSON.stringify(inspection.gives)} != +${record.giveAmount} of the give colour`);
    }
    if (inspection.wants.length !== 1 || want.length !== 1 || want[0]!.amount !== record.wantAmount) {
      own.push(`wants ${JSON.stringify(inspection.wants)} != -${record.wantAmount} of the want colour`);
    }
    if (inspection.ttl !== undefined && Math.abs(Date.parse(inspection.ttl) - Date.parse(current.expiresAt)) > tolerance) {
      own.push(`TTL ${inspection.ttl} differs from the journal's expiresAt ${current.expiresAt}`);
    }
    if (options.pool && !options.pool.has(current.coinNonce)) own.push("pinned coin is not in the test coin pool");
    if (options.reserves?.has(current.coinNonce)) own.push("pinned coin is a reserve coin");
    if (record.side !== undefined && record.pair !== undefined && give.length === 1 && want.length === 1) {
      const [baseSymbol, quoteSymbol] = record.pair.split("/") as [string, string];
      const base = decimals[baseSymbol];
      const quote = decimals[quoteSymbol];
      if (base !== undefined && quote !== undefined && !withinLevel(record.side, record.price, BigInt(give[0]!.amount), BigInt(want[0]!.amount), { base, quote })) {
        own.push(`${record.side} legs trade beyond its level price ${record.price}`);
      }
    }
    offers.push({
      slot: record.slot,
      ...(record.side === undefined ? {} : { side: record.side, pair: record.pair, price: record.price }),
      state: record.state,
      offerId: current.offerId,
      coinNonce: current.coinNonce,
      coinNullifier: current.coinNullifier,
      gives: inspection.gives,
      wants: inspection.wants,
      ttl: inspection.ttl,
      expiresAt: current.expiresAt,
      bytes: inspection.bytes,
      problems: own,
    });
    for (const p of own) problems.push(`${record.slot}: ${p}`);
  }
  const distinct = (values: string[], what: string): void => {
    if (new Set(values).size !== values.length) problems.push(`${what} are not all distinct`);
  };
  distinct(offers.map((o) => o.offerId), "offer ids");
  distinct(offers.map((o) => o.coinNonce), "pinned coins");
  distinct(offers.map((o) => o.coinNullifier), "input nullifiers");
  const books = bookSummary(journal.slots(), decimals);
  for (const book of books) if (book.crossed) problems.push(`book ${book.pair} is crossed: best bid ${book.bestBid} >= best ask ${book.bestAsk}`);
  return { pass: problems.length === 0, offers, books, withoutOffer, problems };
};
