/**
 * The PUBLIC maker addresses file: what the owner needs to fund the makers.
 *
 * Built from the secrets file by re-deriving every wallet in memory; it holds addresses
 * and public keys only (never a mnemonic or a secret key). Two renderings: JSON (in the
 * repository, `ladders/makers.stagenet.public.json`) and Markdown (for the plan folder).
 *
 * @module
 */
import { buildSlots, formatRatio, type LadderFile } from "./ladder.ts";
import { identityOf, type MakersFile, type PublicWalletIdentity, verifyIdentityAddresses } from "./wallets.ts";

export interface PublicMakerEntry extends PublicWalletIdentity {
  readonly slot: string;
  readonly ladder: string;
  readonly level: number;
  /**
   * The price of the slot that uses this wallet, from the ladder file (grid: want per give,
   * 3 decimals; book: quote per base as configured); `null` when no slot uses it.
   */
  readonly price: string | null;
  readonly gives: string | null;
  readonly wants: string | null;
  /** Whole give tokens per offer. */
  readonly giveTokensPerOffer: string | null;
}

export interface PublicMakersFile {
  readonly version: 1;
  readonly networkId: string;
  readonly generatedAt: string;
  readonly derivation: string;
  readonly howToFund: readonly string[];
  readonly makers: readonly PublicMakerEntry[];
}

export const HOW_TO_FUND: readonly string[] = [
  "Book makers (00057 onwards) get their give inventory by SHIELDED transfer from the funding wallet: `makers:fund --ladder-file <book> [--slots …]` sends each maker its ladder's `inventoryTokens` to its shielded address (mn_shield-addr_stagenet1…).",
  "Making offers is fee-free for a maker (the taker pays), so a maker needs no NIGHT or DUST to post offers. Makers added with `wallets:add` (00058) get no NIGHT: they cannot move tokens out, or retire an offer by spending its coin, until someone sends NIGHT to their UNSHIELDED address (mn_addr_stagenet1…) and runs `makers:register-dust`.",
  "History: the first 20 makers (AB-01…10, BC-01…10, 00053) were funded with NIGHT by hand (the stagenet faucet has a CAPTCHA), registered for DUST with `makers:register-dust` and self-minted native stk inventory with `makers:mint`; that route is retired.",
  "The DUST addresses are listed for reference only.",
];

/**
 * Derive every maker's public identity (in memory) and join the ladder prices. A maker is
 * joined to the slot that uses it: the slot's `walletId` (a book's `wallets` mapping, e.g.
 * AASK-01 → AB-01), which defaults to the slot id (00053).
 */
export const buildPublicMakers = (makers: MakersFile, ladders: LadderFile | undefined): PublicMakersFile => {
  const slots = new Map((ladders ? buildSlots(ladders) : []).map((slot) => [slot.walletId, slot]));
  const entries: PublicMakerEntry[] = makers.makers.map((maker) => {
    const identity = identityOf(maker.mnemonic, makers.networkId);
    verifyIdentityAddresses(identity, makers.networkId);
    const slot = slots.get(maker.slot);
    const giveDecimals = slot ? ladders!.tokens[slot.giveSymbol]!.decimals : 0;
    return {
      slot: maker.slot,
      ladder: maker.ladder,
      level: maker.level,
      price: slot ? slot.priceText : null,
      gives: slot ? slot.giveSymbol : null,
      wants: slot ? slot.wantSymbol : null,
      giveTokensPerOffer: slot ? formatRatio({ num: slot.giveAmount, den: 10n ** BigInt(giveDecimals) }, 0) : null,
      ...identity,
    };
  });
  return {
    version: 1,
    networkId: makers.networkId,
    generatedAt: new Date().toISOString(),
    derivation: makers.derivation,
    howToFund: HOW_TO_FUND,
    makers: entries,
  };
};

/** Markdown rendering for the plan folder. */
export const renderPublicMakersMarkdown = (file: PublicMakersFile, sourceNote: string): string => {
  const lines: string[] = [];
  lines.push("# 00053-stagenet-offer-ladders — maker addresses (public)");
  lines.push("");
  lines.push(`Generated ${file.generatedAt} from the maker secrets file by re-deriving each wallet in memory. ${sourceNote}`);
  lines.push("This file holds **public** data only: addresses and public keys. The mnemonics never leave the secrets file.");
  lines.push("");
  lines.push(`- Network: \`${file.networkId}\``);
  lines.push(`- Derivation: ${file.derivation}`);
  lines.push(`- Makers: ${file.makers.length}`);
  lines.push("");
  lines.push("## How to fund");
  lines.push("");
  file.howToFund.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
  lines.push("## Unshielded addresses (send NIGHT here)");
  lines.push("");
  lines.push("| Slot | Ladder | Price (want per give) | Offer | Unshielded address (send NIGHT here) |");
  lines.push("|---|---|---|---|---|");
  for (const maker of file.makers) {
    const offer = maker.gives ? `give ${maker.giveTokensPerOffer} ${maker.gives}, want ${maker.wants}` : "—";
    lines.push(`| ${maker.slot} | ${maker.ladder} | ${maker.price ?? "—"} | ${offer} | \`${maker.unshieldedAddress}\` |`);
  }
  lines.push("");
  lines.push("## Shielded and DUST addresses (reference only)");
  lines.push("");
  lines.push("| Slot | Shielded address | DUST address |");
  lines.push("|---|---|---|");
  for (const maker of file.makers) {
    lines.push(`| ${maker.slot} | \`${maker.shieldedAddress}\` | \`${maker.dustAddress}\` |`);
  }
  lines.push("");
  return lines.join("\n");
};

export interface AddressCheck {
  readonly makers: number;
  readonly addresses: number;
  readonly distinctAddresses: number;
  readonly distinctMnemonics: number;
  readonly matchesPublicFile: boolean | null;
  readonly problems: readonly string[];
}

/**
 * Re-derive every maker from the secrets file and check: all addresses parse for the
 * network id, every address is distinct across makers, every mnemonic is distinct, and
 * (when given) the public file lists exactly the same identities per slot.
 */
export const checkMakers = (makers: MakersFile, published: PublicMakersFile | undefined): AddressCheck => {
  const problems: string[] = [];
  const addresses = new Set<string>();
  const mnemonics = new Set<string>();
  let count = 0;
  const derived = new Map<string, PublicWalletIdentity>();
  for (const maker of makers.makers) {
    mnemonics.add(maker.mnemonic);
    const identity = identityOf(maker.mnemonic, makers.networkId);
    try {
      verifyIdentityAddresses(identity, makers.networkId);
    } catch (error) {
      problems.push(`${maker.slot}: ${(error as Error).message}`);
    }
    for (const address of [identity.unshieldedAddress, identity.shieldedAddress, identity.dustAddress]) {
      count += 1;
      addresses.add(address);
    }
    derived.set(maker.slot, identity);
  }
  if (addresses.size !== count) problems.push(`${count - addresses.size} duplicate address(es)`);
  if (mnemonics.size !== makers.makers.length) problems.push("duplicate mnemonics");
  let matchesPublicFile: boolean | null = null;
  if (published !== undefined) {
    matchesPublicFile = published.networkId === makers.networkId && published.makers.length === makers.makers.length;
    for (const entry of published.makers) {
      const identity = derived.get(entry.slot);
      const same =
        identity !== undefined &&
        identity.unshieldedAddress === entry.unshieldedAddress &&
        identity.shieldedAddress === entry.shieldedAddress &&
        identity.dustAddress === entry.dustAddress &&
        identity.coinPublicKey === entry.coinPublicKey &&
        identity.encryptionPublicKey === entry.encryptionPublicKey;
      if (!same) {
        matchesPublicFile = false;
        problems.push(`${entry.slot}: public file differs from the re-derived identity`);
      }
    }
    if (published.makers.length !== makers.makers.length) problems.push("public file and secrets file list different slot counts");
  }
  return {
    makers: makers.makers.length,
    addresses: count,
    distinctAddresses: addresses.size,
    distinctMnemonics: mnemonics.size,
    matchesPublicFile,
    problems,
  };
};
