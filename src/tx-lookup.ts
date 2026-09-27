/**
 * Indexer fallback for a missed `Finalized` notice (plan 00053 P12; the P11 BC-09 case).
 *
 * `facade.submitTransaction(tx, 'Finalized')` can miss the node's finalization event and
 * wait until the caller's deadline although the transaction is already in a block. P11 saw
 * this once: BC-09's DUST registration was included (block 637,837, `SUCCESS`) while the
 * command reported `TimeoutError`. Before reporting such a timeout, the maker tooling now
 * asks the indexer about the transaction it handed to the node:
 *
 * - included with `SUCCESS` → the operation succeeded; the caller reports it with a note;
 * - not included, another status, or the indexer cannot answer → the original timeout
 *   error stands (with the indexer's answer appended), so a pending mint record is kept.
 *
 * Public data only: the lookup sends a transaction identifier or hash to the indexer.
 *
 * @module
 */
import { withTimeout } from "./scheduler.ts";

/** A transaction as the indexer reports it. `status`: SUCCESS | PARTIAL_SUCCESS | FAILURE. */
export interface IndexedTx {
  readonly hash: string;
  readonly blockHeight: number;
  readonly status: string;
  readonly identifiers: readonly string[];
}

export type TxRef = { readonly identifier: string } | { readonly hash: string };

const QUERY =
  "query($offset: TransactionOffset!) { transactions(offset: $offset) { hash block { height } " +
  "... on RegularTransaction { identifiers transactionResult { status } } } }";

/** Look a transaction up on the indexer by identifier or hash; `undefined` = not indexed. */
export const lookupTransaction = async (
  indexerUrl: string,
  ref: TxRef,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<IndexedTx | undefined> => {
  const value = "identifier" in ref ? ref.identifier : ref.hash;
  if (!/^[0-9a-f]{64,}$/u.test(value)) throw new Error("a transaction identifier or hash must be lowercase hex");
  const offset = "identifier" in ref ? { identifier: ref.identifier } : { hash: ref.hash };
  const response = await fetchImpl(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { offset } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`indexer transactions query: HTTP ${response.status}`);
  const body = (await response.json()) as {
    data?: { transactions?: unknown } | null;
    errors?: readonly { message?: string }[];
  };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`indexer transactions query: ${String(body.errors[0]?.message ?? "error")}`);
  }
  const list = body.data?.transactions;
  if (!Array.isArray(list)) throw new Error("indexer transactions query: malformed response");
  const tx = list[0] as
    | { hash?: unknown; block?: { height?: unknown }; identifiers?: unknown; transactionResult?: { status?: unknown } }
    | undefined;
  if (tx === undefined) return undefined;
  if (typeof tx.hash !== "string") throw new Error("indexer transactions query: malformed transaction");
  return {
    hash: tx.hash,
    blockHeight: typeof tx.block?.height === "number" ? tx.block.height : -1,
    status: typeof tx.transactionResult?.status === "string" ? tx.transactionResult.status : "UNKNOWN",
    identifiers: Array.isArray(tx.identifiers) ? tx.identifiers.filter((i): i is string => typeof i === "string") : [],
  };
};

export interface SubmissionOutcome<T> {
  /** The submission's own result (it finished before the deadline). */
  readonly value?: T;
  /** Set instead of `value` when the deadline passed but the indexer has the tx with SUCCESS. */
  readonly indexed?: IndexedTx;
}

export interface FallbackOptions {
  readonly timeoutMs: number;
  readonly label: string;
  /** The identifier of the transaction handed to the node, or undefined if none was. */
  readonly identifier: () => string | undefined;
  readonly lookup: (identifier: string) => Promise<IndexedTx | undefined>;
  /** Lookups when the indexer has not indexed it yet or cannot answer [3], `pauseMs` apart [10 s]. */
  readonly attempts?: number;
  readonly pauseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/**
 * Run a submission under a deadline. On a `TimeoutError` after the transaction was handed
 * to the node, ask the indexer: `SUCCESS` → `{ indexed }`; otherwise rethrow the timeout
 * (message extended with what the indexer said). Any other error is rethrown unchanged.
 */
export const submitWithIndexerFallback = async <T>(run: () => Promise<T>, options: FallbackOptions): Promise<SubmissionOutcome<T>> => {
  try {
    return { value: await withTimeout(run(), options.timeoutMs, options.label) };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    const identifier = options.identifier();
    if (identifier === undefined) throw error; // never reached the node: nothing to look up
    options.log?.(`${options.label}: no Finalized notice before the deadline; looking up ${identifier.slice(0, 16)}… on the indexer`);
    const attempts = Math.max(1, options.attempts ?? 3);
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let answer = "not indexed";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const tx = await options.lookup(identifier);
        if (tx?.status === "SUCCESS") {
          options.log?.(`${options.label}: the indexer has it with SUCCESS (block ${tx.blockHeight}, hash ${tx.hash.slice(0, 16)}…)`);
          return { indexed: tx };
        }
        if (tx !== undefined) {
          answer = `included with status ${tx.status} (block ${tx.blockHeight})`;
          break; // a final answer: no point asking again
        }
        answer = "not indexed";
      } catch (lookupError) {
        answer = `indexer lookup failed (${message(lookupError)})`;
      }
      if (attempt < attempts) await sleep(options.pauseMs ?? 10_000);
    }
    const wrapped = new Error(`${error.message}; indexer: ${answer}`);
    wrapped.name = "TimeoutError";
    throw wrapped;
  }
};
