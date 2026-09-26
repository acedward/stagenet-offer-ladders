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
 * @module
 */
import type { Journal } from "./journal.ts";
import { inspectOffer } from "./offer-inspect.ts";
import type { Outbox } from "./outbox.ts";

export interface OfferCheck {
  readonly slot: string;
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
  readonly problems: readonly string[];
}

export const verifyCurrentOffers = (
  journal: Journal,
  outbox: Outbox,
  options: { pool?: ReadonlySet<string>; reserves?: ReadonlySet<string>; ttlToleranceMs?: number } = {},
): VerifyResult => {
  const offers: OfferCheck[] = [];
  const problems: string[] = [];
  const tolerance = options.ttlToleranceMs ?? 120_000;
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
    offers.push({
      slot: record.slot,
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
  return { pass: problems.length === 0, offers, problems };
};
