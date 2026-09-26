/**
 * Maker provisioning (plan P4): register each maker's NIGHT for DUST generation, then
 * self-mint its give token as ONE inventory coin.
 *
 * The decisions are pure and the loops take an injected `open(maker)` port, so the
 * idempotence and skip rules are unit-tested with fakes. Makers are processed ONE AT A
 * TIME (one wallet facade open at once), with an optional stagger.
 *
 * - `makers:register-dust` (reference: `registerNightForDust` in
 *   `@effectstream/midnight-contracts@0.200.6` `src/get-wallet-info.ts`, read from the npm
 *   tarball, not depended on): unregistered NIGHT UTxOs → `estimateRegistration` →
 *   `waitForGeneratedDust(fee)` → `registerNightUtxosForDustGeneration` → `finalizeRecipe`
 *   → `submitTransaction`. Skips a maker with no NIGHT and one whose NIGHT is all
 *   registered already.
 * - `makers:mint`: `mint(self, INVENTORY_OFFERS × give, nonce)` on the give token's
 *   contract (AB → stkA, BC → stkB), through 00052's providers. Skips a maker that
 *   already holds at least that amount of its give token, and one without enough DUST.
 *
 * @module
 */

export interface MakerRef {
  readonly slot: string;
  readonly ladder: string;
}

export interface MakerStatus {
  /** NIGHT UTxOs (value in STAR, whether registered for DUST generation). */
  readonly nightUtxos: readonly { value: bigint; registered: boolean }[];
  /** Spendable DUST now, in SPECK. */
  readonly dust: bigint;
  /** Spendable balance of the maker's give token, base units. */
  readonly giveBalance: bigint;
}

export interface MakerOps {
  status(): Promise<MakerStatus>;
  /** Register the unregistered NIGHT UTxOs; returns the submitted transaction id. */
  registerDust(): Promise<{ txId: string }>;
  /** Mint `amount` base units of the give token to self as one coin. */
  mintGive(amount: bigint): Promise<{ txHash: string; blockHeight: number; status: string; coinNonce: string }>;
  close(): Promise<void>;
}

export type RegisterDecision = "register" | "skip-no-night" | "skip-already-registered";
export type MintDecision = "mint" | "skip-already-holds" | "skip-already-minted" | "skip-no-dust";

export const registerDecision = (status: MakerStatus): RegisterDecision => {
  if (status.nightUtxos.length === 0 || status.nightUtxos.every((u) => u.value === 0n)) return "skip-no-night";
  if (status.nightUtxos.every((u) => u.registered)) return "skip-already-registered";
  return "register";
};

/**
 * `alreadyMinted`: a successful inventory mint is recorded for this maker (so a maker whose
 * offers were filled below the target is not topped up again by a re-run; the owner mints
 * once, spec US2).
 */
export const mintDecision = (status: MakerStatus, target: bigint, minDust: bigint, alreadyMinted = false): MintDecision => {
  if (alreadyMinted) return "skip-already-minted";
  if (status.giveBalance >= target) return "skip-already-holds";
  if (status.dust < minDust) return "skip-no-dust";
  return "mint";
};

export interface MakerResult {
  readonly slot: string;
  readonly action: string;
  readonly detail?: Record<string, unknown>;
  readonly error?: string;
}

const message = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

const forEachMaker = async (
  makers: readonly MakerRef[],
  open: (maker: MakerRef) => Promise<MakerOps>,
  step: (maker: MakerRef, ops: MakerOps) => Promise<MakerResult>,
  options: { staggerMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void },
): Promise<MakerResult[]> => {
  const results: MakerResult[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (const [index, maker] of makers.entries()) {
    if (index > 0 && (options.staggerMs ?? 0) > 0) await sleep(options.staggerMs!);
    let ops: MakerOps | undefined;
    try {
      ops = await open(maker);
      const result = await step(maker, ops);
      results.push(result);
      options.log?.(`${maker.slot}: ${result.action}`);
    } catch (error) {
      // One maker's failure never stops the others.
      results.push({ slot: maker.slot, action: "error", error: message(error) });
      options.log?.(`${maker.slot}: error ${message(error)}`);
    } finally {
      await ops?.close().catch(() => undefined);
    }
  }
  return results;
};

export const registerDustAll = (
  makers: readonly MakerRef[],
  open: (maker: MakerRef) => Promise<MakerOps>,
  options: { staggerMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<MakerResult[]> =>
  forEachMaker(
    makers,
    open,
    async (maker, ops) => {
      const status = await ops.status();
      const decision = registerDecision(status);
      if (decision !== "register") return { slot: maker.slot, action: decision };
      const { txId } = await ops.registerDust();
      return {
        slot: maker.slot,
        action: "registered",
        detail: { txId, utxos: status.nightUtxos.filter((u) => !u.registered).length },
      };
    },
    options,
  );

export const mintAll = (
  makers: readonly MakerRef[],
  open: (maker: MakerRef) => Promise<MakerOps>,
  target: bigint,
  minDust: bigint,
  options: {
    staggerMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    /** Slots with a recorded successful inventory mint. */
    minted?: ReadonlySet<string>;
    /** Called after each successful mint (to record it before the next maker). */
    onMinted?: (slot: string, detail: Record<string, unknown>) => void;
  } = {},
): Promise<MakerResult[]> =>
  forEachMaker(
    makers,
    open,
    async (maker, ops) => {
      if (options.minted?.has(maker.slot)) return { slot: maker.slot, action: "skip-already-minted" };
      const status = await ops.status();
      const decision = mintDecision(status, target, minDust);
      if (decision !== "mint") return { slot: maker.slot, action: decision, detail: { giveBalance: status.giveBalance, dust: status.dust } };
      const minted = await ops.mintGive(target);
      const detail = { ...minted, amount: target };
      if (minted.status === "SucceedEntirely") options.onMinted?.(maker.slot, detail);
      return { slot: maker.slot, action: minted.status === "SucceedEntirely" ? "minted" : "mint-failed", detail };
    },
    options,
  );
