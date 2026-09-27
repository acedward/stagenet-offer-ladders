/**
 * Ladder definition: the price grid, the offer amounts and the slot list.
 *
 * A ladder is N fixed-price offers of one direction (give `give`, want `want`), in one of
 * two forms:
 *
 * - **Grid** (00053): slot `i` (0-based) sells `giveAmount` base units of the give token for
 *   `wantAmount_i = round(giveAmount × price_i)` base units of the want token, where
 *
 *       price_i = mid × ((1 − spread) + 2 · spread · i / (levels − 1))      (want per give)
 *
 *   With the defaults (mid 1.0, spread 0.2, 10 levels) the prices are 0.800, 0.844, 0.889,
 *   0.933, 0.978, 1.022, 1.067, 1.111, 1.156, 1.200 (spec Q3 = A); `round` is half-up.
 * - **Book** (00057): one side of a `base`/`quote` market with explicit `prices` in QUOTE PER
 *   BASE (e.g. USDC per stock), best level first. An `ask` gives `giveTokens` of base for
 *   `ceil(give × price)` of quote; a `bid` gives `giveTokens` of quote for
 *   `ceil(give / price)` of base. Both round up, in the maker's favour: an ask never sells
 *   below its level and a bid never pays more than its level. A book whose lowest ask is not
 *   above its highest bid is refused.
 *
 * Each slot uses the maker wallet named by the ladder's `wallets` list (one per level), or
 * by default the wallet whose id is the slot id (00053). All arithmetic on amounts is exact
 * (bigint rationals). Every slot's price is fixed for its life.
 *
 * Pure module: no I/O except `readLadderFile`.
 *
 * @module
 */
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------

/** A non-negative rational `num / den`, `den > 0`. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

/** Parse a non-negative decimal string ("1", "0.2", "1.05") into an exact ratio. */
export const parseDecimal = (text: string, what = "value"): Ratio => {
  const value = String(text).trim();
  if (!DECIMAL.test(value)) throw new LadderConfigError(`${what} must be a non-negative decimal string, got ${JSON.stringify(text)}`);
  const [whole, fraction = ""] = value.split(".");
  const den = 10n ** BigInt(fraction.length);
  return { num: BigInt(whole!) * den + BigInt(fraction === "" ? "0" : fraction), den };
};

/** `round(value × ratio)`, half-up, for a non-negative bigint and ratio. */
export const mulRound = (value: bigint, ratio: Ratio): bigint => {
  if (value < 0n) throw new RangeError("value must be non-negative");
  const product = value * ratio.num;
  const quotient = product / ratio.den;
  const remainder = product % ratio.den;
  return remainder * 2n >= ratio.den ? quotient + 1n : quotient;
};

/** `ceil(value × ratio)` for a non-negative bigint and ratio (book ladders round up). */
export const mulCeil = (value: bigint, ratio: Ratio): bigint => {
  if (value < 0n) throw new RangeError("value must be non-negative");
  const product = value * ratio.num;
  return (product + ratio.den - 1n) / ratio.den;
};

/** `a < b` for two ratios. */
export const ratioLess = (a: Ratio, b: Ratio): boolean => a.num * b.den < b.num * a.den;

/** A ratio as a decimal string with `digits` fraction digits (half-up). */
export const formatRatio = (ratio: Ratio, digits = 3): string => {
  const scale = 10n ** BigInt(digits);
  const scaled = mulRound(scale, ratio);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(digits, "0");
  return digits === 0 ? whole.toString() : `${whole}.${fraction}`;
};

/** Whole tokens (decimal string) → base units at `decimals`. Rejects sub-unit precision. */
export const toBaseUnits = (tokens: string, decimals: number): bigint => {
  const ratio = parseDecimal(tokens, "token amount");
  const scaled = ratio.num * 10n ** BigInt(decimals);
  if (scaled % ratio.den !== 0n) throw new LadderConfigError(`${tokens} has more than ${decimals} decimals`);
  return scaled / ratio.den;
};

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** Exact price of level `index` of `levels` (want per give). */
export const levelPrice = (mid: Ratio, spread: Ratio, levels: number, index: number): Ratio => {
  if (!Number.isSafeInteger(levels) || levels < 1) throw new LadderConfigError("levels must be a positive integer");
  if (!Number.isSafeInteger(index) || index < 0 || index >= levels) throw new RangeError(`level index ${index} out of range`);
  if (spread.num >= spread.den) throw new LadderConfigError("spread must be below 1");
  if (levels === 1) return mid;
  // factor = (1 − s) + 2·s·i/(L−1) = ((den − num)(L−1) + 2·num·i) / (den·(L−1))
  const l1 = BigInt(levels - 1);
  const factorNum = (spread.den - spread.num) * l1 + 2n * spread.num * BigInt(index);
  const factorDen = spread.den * l1;
  return { num: mid.num * factorNum, den: mid.den * factorDen };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export class LadderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LadderConfigError";
  }
}

export const WALLET_MODES = ["wallet-per-slot", "single-wallet-pinned"] as const;
export type WalletMode = (typeof WALLET_MODES)[number];

/** How a slot chooses its give coin. */
export const COIN_POLICIES = ["exact", "at-least"] as const;
export type CoinPolicy = (typeof COIN_POLICIES)[number];

/** A book ladder's side: an ask sells base for quote, a bid buys base with quote. */
export const BOOK_SIDES = ["ask", "bid"] as const;
export type BookSide = (typeof BOOK_SIDES)[number];

/** Where a bridged token comes from (AA 00037): its colour is derived from these. */
export interface BridgeDef {
  /** Midnight vault contract address, 64 lowercase hex. */
  readonly vault: string;
  /** The ERC20 the vault locks, `0x` + 40 hex (checksummed or not). */
  readonly erc20: string;
}

export interface TokenDef {
  readonly symbol: string;
  readonly decimals: number;
  /** 64 lowercase hex, or undefined until resolved (deployments file / env). */
  readonly colour?: string | undefined;
  readonly bridge?: BridgeDef | undefined;
}

/** The book form of a ladder (00057): one side of a base/quote market. */
export interface BookDef {
  readonly side: BookSide;
  readonly base: string;
  readonly quote: string;
  /** Exact decimal strings, quote per base, best level first. */
  readonly prices: readonly string[];
}

export interface LadderDef {
  readonly id: string;
  /** Give / want token symbols (a book ladder derives them from its side). */
  readonly give: string;
  readonly want: string;
  readonly levels: number;
  /** Whole give tokens per offer. */
  readonly giveTokens: string;
  /** Grid form only: the symmetric grid around `mid`, want per give. */
  readonly mid?: string | undefined;
  readonly spread?: string | undefined;
  /** Book form only. */
  readonly book?: BookDef | undefined;
  /** Whole give tokens each maker should hold (`makers:fund`). */
  readonly inventoryTokens?: string | undefined;
  /** Maker wallet id per level (default: the slot id). */
  readonly wallets?: readonly string[] | undefined;
}

export interface LadderFile {
  readonly version: 1;
  readonly networkId: string;
  readonly mode: WalletMode;
  readonly coinPolicy?: CoinPolicy | undefined;
  readonly tokens: Readonly<Record<string, TokenDef>>;
  readonly ladders: readonly LadderDef[];
  /** Nonces (64 hex) never assigned to a slot, e.g. taker reserves in single-wallet mode. */
  readonly excludeNonces?: readonly string[] | undefined;
  /**
   * If set, ONLY these nonces may be assigned to slots (a fixed coin pool; single-wallet
   * test). Coins the wallet receives later (e.g. a settlement's outputs) are never adopted.
   */
  readonly includeNonces?: readonly string[] | undefined;
  /**
   * If set, ONLY these slots run (a staged rollout: e.g. `["AB-01", "AB-02", "BC-01"]`). Each
   * slot keeps the price and amounts it has in the full ladder, so a journal started with a
   * subset carries over unchanged when the full ladder file is used later (P12).
   */
  readonly onlySlots?: readonly string[] | undefined;
}

/** One ladder slot: a fixed-price offer position. */
export interface Slot {
  /** `AB-01` … */
  readonly id: string;
  readonly ladder: string;
  /** 0-based level index. */
  readonly level: number;
  /** Exact price (want per give). */
  readonly price: Ratio;
  /**
   * Display price: want per give with 3 decimals (grid), or the configured quote-per-base
   * string (book, e.g. `0.0104`).
   */
  readonly priceText: string;
  readonly giveSymbol: string;
  readonly wantSymbol: string;
  readonly giveAmount: bigint;
  readonly wantAmount: bigint;
  /** The maker wallet (secrets-file id) this slot uses in wallet-per-slot mode. */
  readonly walletId: string;
  /** Book slots only: the side and the pair (`base/quote`). */
  readonly side?: BookSide | undefined;
  readonly pair?: string | undefined;
}

export const slotId = (ladder: string, level: number): string => `${ladder}-${String(level + 1).padStart(2, "0")}`;

const LADDER_ID = /^[A-Z][A-Z0-9]{0,7}$/u;
/** A wallet id in the makers secrets file (the 00053 slot ids: `AB-01` …). */
const WALLET_ID = /^[A-Z][A-Z0-9]{0,7}-[0-9]{2}$/u;
/** A colour still to be filled in (e.g. a bridged token not bridged yet). */
const PLACEHOLDER = /^PENDING\b/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type LadderShape = Omit<LadderDef, "inventoryTokens" | "wallets">;

/** The 00053 grid form: give, want, mid, spread, levels (defaults 1.0, 0.2, 10). */
const parseGridLadder = (id: string, entry: Record<string, unknown>, tokens: Readonly<Record<string, TokenDef>>): LadderShape => {
  for (const key of ["base", "quote", "prices"]) {
    if (entry[key] !== undefined) throw new LadderConfigError(`ladder ${id}: "${key}" belongs to a book ladder (set "side")`);
  }
  const give = entry["give"];
  const want = entry["want"];
  if (typeof give !== "string" || tokens[give] === undefined) throw new LadderConfigError(`ladder ${id}: unknown give token ${JSON.stringify(give)}`);
  if (typeof want !== "string" || tokens[want] === undefined) throw new LadderConfigError(`ladder ${id}: unknown want token ${JSON.stringify(want)}`);
  if (give === want) throw new LadderConfigError(`ladder ${id}: give and want must differ`);
  const mid = String(entry["mid"] ?? "1.0");
  const spread = String(entry["spread"] ?? "0.2");
  const levels = entry["levels"] ?? 10;
  const giveTokens = String(entry["giveTokens"] ?? "100");
  parseDecimal(mid, `ladder ${id} mid`);
  if (parseDecimal(mid).num === 0n) throw new LadderConfigError(`ladder ${id}: mid must be positive`);
  const s = parseDecimal(spread, `ladder ${id} spread`);
  if (s.num >= s.den) throw new LadderConfigError(`ladder ${id}: spread must be below 1`);
  if (!Number.isSafeInteger(levels) || (levels as number) < 1 || (levels as number) > 99) {
    throw new LadderConfigError(`ladder ${id}: levels must be an integer 1-99`);
  }
  if (toBaseUnits(giveTokens, tokens[give]!.decimals) <= 0n) throw new LadderConfigError(`ladder ${id}: giveTokens must be positive`);
  return { id, give, want, mid, spread, levels: levels as number, giveTokens };
};

/** The 00057 book form: side, base, quote, prices (quote per base, best first), giveTokens. */
const parseBookLadder = (id: string, entry: Record<string, unknown>, tokens: Readonly<Record<string, TokenDef>>): LadderShape => {
  const side = entry["side"];
  if (!(BOOK_SIDES as readonly unknown[]).includes(side)) throw new LadderConfigError(`ladder ${id}: "side" must be one of ${BOOK_SIDES.join(", ")}`);
  for (const key of ["give", "want", "mid", "spread", "levels"]) {
    if (entry[key] !== undefined) throw new LadderConfigError(`ladder ${id}: "${key}" is not used by a book ladder (side, base, quote, prices)`);
  }
  const base = entry["base"];
  const quote = entry["quote"];
  if (typeof base !== "string" || tokens[base] === undefined) throw new LadderConfigError(`ladder ${id}: unknown base token ${JSON.stringify(base)}`);
  if (typeof quote !== "string" || tokens[quote] === undefined) throw new LadderConfigError(`ladder ${id}: unknown quote token ${JSON.stringify(quote)}`);
  if (base === quote) throw new LadderConfigError(`ladder ${id}: base and quote must differ`);
  const pricesRaw = entry["prices"];
  if (!Array.isArray(pricesRaw) || pricesRaw.length < 1 || pricesRaw.length > 99 || !pricesRaw.every((p) => typeof p === "string")) {
    throw new LadderConfigError(`ladder ${id}: "prices" must be an array of 1-99 decimal strings (quote per base)`);
  }
  const prices = pricesRaw as string[];
  const ratios = prices.map((p, i) => parseDecimal(p, `ladder ${id} prices[${i}]`));
  if (ratios.some((r) => r.num === 0n)) throw new LadderConfigError(`ladder ${id}: prices must be positive`);
  for (let i = 1; i < ratios.length; i++) {
    // Best level first: asks rise away from mid, bids fall away from it.
    const ordered = side === "ask" ? ratioLess(ratios[i - 1]!, ratios[i]!) : ratioLess(ratios[i]!, ratios[i - 1]!);
    if (!ordered) throw new LadderConfigError(`ladder ${id}: ${side} prices must be strictly ${side === "ask" ? "increasing" : "decreasing"} (best level first)`);
  }
  const giveTokensRaw = entry["giveTokens"];
  if (giveTokensRaw === undefined) throw new LadderConfigError(`ladder ${id}: a book ladder needs "giveTokens"`);
  const giveTokens = String(giveTokensRaw);
  const give = side === "ask" ? base : quote;
  const want = side === "ask" ? quote : base;
  if (toBaseUnits(giveTokens, tokens[give]!.decimals) <= 0n) throw new LadderConfigError(`ladder ${id}: giveTokens must be positive`);
  return { id, give, want, levels: prices.length, giveTokens, book: { side: side as BookSide, base, quote, prices } };
};

/** Per base/quote pair, the lowest ask must be above the highest bid (00057 spec: no crossing). */
const checkBooksDoNotCross = (ladders: readonly LadderShape[]): void => {
  const pairs = new Map<string, { lowestAsk?: Ratio; highestBid?: Ratio }>();
  for (const ladder of ladders) {
    if (ladder.book === undefined) continue;
    const key = `${ladder.book.base}/${ladder.book.quote}`;
    const entry = pairs.get(key) ?? {};
    for (const text of ladder.book.prices) {
      const price = parseDecimal(text);
      if (ladder.book.side === "ask" && (entry.lowestAsk === undefined || ratioLess(price, entry.lowestAsk))) entry.lowestAsk = price;
      if (ladder.book.side === "bid" && (entry.highestBid === undefined || ratioLess(entry.highestBid, price))) entry.highestBid = price;
    }
    pairs.set(key, entry);
  }
  for (const [pair, { lowestAsk, highestBid }] of pairs) {
    if (lowestAsk !== undefined && highestBid !== undefined && !ratioLess(highestBid, lowestAsk)) {
      throw new LadderConfigError(`book ${pair} crosses: the lowest ask ${formatRatio(lowestAsk, 6)} is not above the highest bid ${formatRatio(highestBid, 6)}`);
    }
  }
};

/** Validate a parsed ladder file. Throws `LadderConfigError` naming the first problem. */
export const parseLadderFile = (raw: unknown): LadderFile => {
  if (!isRecord(raw)) throw new LadderConfigError("ladder file must be a JSON object");
  if (raw["version"] !== 1) throw new LadderConfigError(`unsupported ladder file version ${JSON.stringify(raw["version"])}`);
  const networkId = raw["networkId"];
  if (typeof networkId !== "string" || networkId === "") throw new LadderConfigError('"networkId" is required');
  const mode = raw["mode"];
  if (!(WALLET_MODES as readonly unknown[]).includes(mode)) {
    throw new LadderConfigError(`"mode" must be one of ${WALLET_MODES.join(", ")}`);
  }
  const coinPolicy = raw["coinPolicy"];
  if (coinPolicy !== undefined && !(COIN_POLICIES as readonly unknown[]).includes(coinPolicy)) {
    throw new LadderConfigError(`"coinPolicy" must be one of ${COIN_POLICIES.join(", ")}`);
  }
  const tokensRaw = raw["tokens"];
  if (!isRecord(tokensRaw)) throw new LadderConfigError('"tokens" must be an object');
  const tokens: Record<string, TokenDef> = {};
  for (const [symbol, def] of Object.entries(tokensRaw)) {
    if (!isRecord(def)) throw new LadderConfigError(`token ${symbol} must be an object`);
    const decimals = def["decimals"];
    if (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
      throw new LadderConfigError(`token ${symbol}: "decimals" must be an integer 0-18`);
    }
    const colour = def["colour"];
    if (typeof colour === "string" && PLACEHOLDER.test(colour)) {
      // 00057: a placeholder never reaches a wallet; the file is unusable until it is filled in.
      throw new LadderConfigError(`token ${symbol}: "colour" is a placeholder (${JSON.stringify(colour)}); fill in the recorded colour before using this file`);
    }
    if (colour !== undefined && colour !== null && (typeof colour !== "string" || !/^[0-9a-f]{64}$/u.test(colour))) {
      throw new LadderConfigError(`token ${symbol}: "colour" must be 64 lowercase hex or null`);
    }
    const bridgeRaw = def["bridge"];
    let bridge: BridgeDef | undefined;
    if (bridgeRaw !== undefined) {
      if (!isRecord(bridgeRaw)) throw new LadderConfigError(`token ${symbol}: "bridge" must be an object`);
      const vault = bridgeRaw["vault"];
      const erc20 = bridgeRaw["erc20"];
      if (typeof vault !== "string" || !/^[0-9a-f]{64}$/u.test(vault)) throw new LadderConfigError(`token ${symbol}: "bridge.vault" must be 64 lowercase hex`);
      if (typeof erc20 !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(erc20)) throw new LadderConfigError(`token ${symbol}: "bridge.erc20" must be 0x + 40 hex`);
      if (typeof colour !== "string") throw new LadderConfigError(`token ${symbol}: a bridged token needs an explicit "colour"`);
      bridge = { vault, erc20 };
    }
    tokens[symbol] = { symbol, decimals: decimals as number, colour: typeof colour === "string" ? colour : undefined, bridge };
  }
  const laddersRaw = raw["ladders"];
  if (!Array.isArray(laddersRaw) || laddersRaw.length === 0) throw new LadderConfigError('"ladders" must be a non-empty array');
  const seen = new Set<string>();
  const ladders: LadderDef[] = laddersRaw.map((entry, index) => {
    if (!isRecord(entry)) throw new LadderConfigError(`ladders[${index}] must be an object`);
    const id = entry["id"];
    if (typeof id !== "string" || !LADDER_ID.test(id)) throw new LadderConfigError(`ladders[${index}].id must match ${LADDER_ID}`);
    if (seen.has(id)) throw new LadderConfigError(`duplicate ladder id ${id}`);
    seen.add(id);
    const ladder = entry["side"] === undefined ? parseGridLadder(id, entry, tokens) : parseBookLadder(id, entry, tokens);
    const give = ladder.give;
    const inventoryRaw = entry["inventoryTokens"];
    let inventoryTokens: string | undefined;
    if (inventoryRaw !== undefined) {
      inventoryTokens = String(inventoryRaw);
      const inventory = toBaseUnits(inventoryTokens, tokens[give]!.decimals);
      if (inventory < toBaseUnits(ladder.giveTokens, tokens[give]!.decimals)) {
        throw new LadderConfigError(`ladder ${id}: inventoryTokens must be at least giveTokens`);
      }
    }
    const walletsRaw = entry["wallets"];
    let wallets: string[] | undefined;
    if (walletsRaw !== undefined) {
      if (!Array.isArray(walletsRaw) || !walletsRaw.every((w) => typeof w === "string" && WALLET_ID.test(w))) {
        throw new LadderConfigError(`ladder ${id}: "wallets" must be an array of wallet ids like "AB-01"`);
      }
      if (walletsRaw.length !== ladder.levels) throw new LadderConfigError(`ladder ${id}: "wallets" must name one wallet per level (${ladder.levels})`);
      wallets = walletsRaw as string[];
    }
    return { ...ladder, inventoryTokens, wallets };
  });
  // Every slot needs its own maker wallet (wallet-per-slot): the mapped ids must not collide.
  const walletOwner = new Map<string, string>();
  for (const ladder of ladders) {
    for (let level = 0; level < ladder.levels; level++) {
      const wallet = ladder.wallets?.[level] ?? slotId(ladder.id, level);
      const other = walletOwner.get(wallet);
      if (other !== undefined) throw new LadderConfigError(`wallet ${wallet} is used by slots ${other} and ${slotId(ladder.id, level)}`);
      walletOwner.set(wallet, slotId(ladder.id, level));
    }
  }
  checkBooksDoNotCross(ladders);
  const excludeRaw = raw["excludeNonces"];
  let excludeNonces: string[] | undefined;
  if (excludeRaw !== undefined) {
    if (!Array.isArray(excludeRaw) || !excludeRaw.every((n) => typeof n === "string" && /^[0-9a-f]{64}$/u.test(n))) {
      throw new LadderConfigError('"excludeNonces" must be an array of 64-hex nonces');
    }
    excludeNonces = excludeRaw as string[];
  }
  const includeRaw = raw["includeNonces"];
  let includeNonces: string[] | undefined;
  if (includeRaw !== undefined) {
    if (!Array.isArray(includeRaw) || !includeRaw.every((n) => typeof n === "string" && /^[0-9a-f]{64}$/u.test(n))) {
      throw new LadderConfigError('"includeNonces" must be an array of 64-hex nonces');
    }
    includeNonces = includeRaw as string[];
  }
  const onlyRaw = raw["onlySlots"];
  let onlySlots: string[] | undefined;
  if (onlyRaw !== undefined) {
    if (!Array.isArray(onlyRaw) || onlyRaw.length === 0 || !onlyRaw.every((s) => typeof s === "string" && /^[A-Z][A-Z0-9]{0,7}-[0-9]{2}$/u.test(s))) {
      throw new LadderConfigError('"onlySlots" must be a non-empty array of slot ids like "AB-01"');
    }
    if (new Set(onlyRaw).size !== onlyRaw.length) throw new LadderConfigError('"onlySlots" lists a slot twice');
    onlySlots = onlyRaw as string[];
  }
  return {
    version: 1,
    networkId,
    mode: mode as WalletMode,
    coinPolicy: coinPolicy as CoinPolicy | undefined,
    tokens,
    ladders,
    excludeNonces,
    includeNonces,
    onlySlots,
  };
};

export const readLadderFile = (path: string): LadderFile => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LadderConfigError(`cannot read ladder file ${path}: ${(error as Error).message}`);
  }
  return parseLadderFile(raw);
};

/**
 * Every slot of every ladder, in ladder order then level order; only the `onlySlots` ones if
 * the file lists them (each keeps its full-ladder level, price and amounts).
 */
export const buildSlots = (file: LadderFile): Slot[] => {
  const all = buildAllSlots(file);
  if (file.onlySlots === undefined) return all;
  const known = new Set(all.map((slot) => slot.id));
  const unknown = file.onlySlots.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new LadderConfigError(`"onlySlots" names slot(s) not in the ladders: ${unknown.join(", ")}`);
  const wanted = new Set(file.onlySlots);
  return all.filter((slot) => wanted.has(slot.id));
};

const buildAllSlots = (file: LadderFile): Slot[] => {
  const slots: Slot[] = [];
  for (const ladder of file.ladders) {
    const give = file.tokens[ladder.give]!;
    const want = file.tokens[ladder.want]!;
    const giveAmount = toBaseUnits(ladder.giveTokens, give.decimals);
    for (let level = 0; level < ladder.levels; level++) {
      const book = ladder.book;
      let price: Ratio;
      if (book === undefined) {
        price = levelPrice(parseDecimal(ladder.mid!), parseDecimal(ladder.spread!), ladder.levels, level);
      } else {
        // Quote per base → want per give: an ask's want is quote (the price), a bid's is base (1 / price).
        const quotePerBase = parseDecimal(book.prices[level]!);
        price = book.side === "ask" ? quotePerBase : { num: quotePerBase.den, den: quotePerBase.num };
      }
      // Both tokens are base units; a decimals difference would scale the want leg.
      const scale: Ratio = want.decimals >= give.decimals
        ? { num: price.num * 10n ** BigInt(want.decimals - give.decimals), den: price.den }
        : { num: price.num, den: price.den * 10n ** BigInt(give.decimals - want.decimals) };
      const id = slotId(ladder.id, level);
      slots.push({
        id,
        ladder: ladder.id,
        level,
        price,
        priceText: book === undefined ? formatRatio(price, 3) : book.prices[level]!,
        giveSymbol: ladder.give,
        wantSymbol: ladder.want,
        giveAmount,
        // Grid: half-up (00053, unchanged). Book: up, so the maker never trades below its level.
        wantAmount: book === undefined ? mulRound(giveAmount, scale) : mulCeil(giveAmount, scale),
        walletId: ladder.wallets?.[level] ?? id,
        ...(book === undefined ? {} : { side: book.side, pair: `${book.base}/${book.quote}` }),
      });
    }
  }
  return slots;
};

/** Resolve token colours: explicit colours in the ladder file win, then `resolved`. */
export const resolveColours = (
  file: LadderFile,
  resolved: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [symbol, token] of Object.entries(file.tokens)) {
    const colour = (token.colour ?? resolved[symbol] ?? "").toLowerCase().replace(/^0x/u, "");
    if (!/^[0-9a-f]{64}$/u.test(colour)) {
      throw new LadderConfigError(
        `token ${symbol} has no colour: set tokens.${symbol}.colour in the ladder file, ` +
          "or provide the deployments file (TOKENS_FILE) that 00052 writes",
      );
    }
    out[symbol] = colour;
  }
  return out;
};

/** The native (NIGHT) token type: never a valid ladder leg. */
export const NATIVE_COLOUR = "0".repeat(64);

/**
 * Audit C11: every ladder's give and want colours must be distinct and non-native, and two
 * different token symbols must not resolve to the same colour. Checked before any wallet opens.
 */
export const validateColours = (file: LadderFile, colours: Readonly<Record<string, string>>): void => {
  const bySymbol = new Map<string, string>();
  for (const [symbol, colour] of Object.entries(colours)) {
    if (colour === NATIVE_COLOUR) throw new LadderConfigError(`token ${symbol} resolves to the native token colour`);
    const other = bySymbol.get(colour);
    if (other !== undefined) throw new LadderConfigError(`tokens ${other} and ${symbol} resolve to the same colour`);
    bySymbol.set(colour, symbol);
  }
  for (const ladder of file.ladders) {
    if (colours[ladder.give] === colours[ladder.want]) throw new LadderConfigError(`ladder ${ladder.id}: give and want colours are equal`);
  }
};
