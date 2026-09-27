/**
 * Colours of bridged tokens (AA 00037's witness-free Sig Network ERC20 vault).
 *
 * The vault mints one shielded colour per locked ERC20:
 *
 *     colour = tokenType(vaultTokenDomainSeparator(erc20), vault)
 *            = rawTokenType(sep, vault)
 *     sep    = upgradeFromTransient(transientHash<Vector<2, Bytes<32>>>([
 *                pad(32, "erc20:vault:"), erc20 as Field as Bytes<32> ]))
 *
 * `vaultTokenDomainSeparator` is re-implemented here from the vault's Compact source
 * (`erc20-vault.compact`, erc20-vault v0.3.0) and its compiled output, with the same
 * compact-runtime 0.19.0 built-ins, so this repository needs neither the vault package nor
 * its artefacts. Unit tests pin it to the colours AA 00037 recorded on stagenet.
 *
 * A ladder file that names a token's `bridge` (vault + ERC20) is refused when its explicit
 * colour is not the derived one: a typo in a colour would otherwise quote an unrelated token.
 *
 * @module
 */
import {
  CompactTypeBytes,
  CompactTypeVector,
  convertBigintToBytes,
  convertBytesToUint,
  transientHash,
  upgradeFromTransient,
} from "@midnight-ntwrk/compact-runtime";
import { rawTokenType } from "@midnightntwrk/ledger-v9";

import { type BridgeDef, LadderConfigError, type LadderFile } from "./ladder.ts";
import { bytesOfHex, pad } from "./tokens.ts";

/** The largest Field value (BLS12-381 scalar field − 1), as the compiled contract bounds the cast. */
const FIELD_MAX = 52435875175126190479447740508185965837690552500527637822603658699938581184512n;

const HASH_INPUT = new CompactTypeVector(2, new CompactTypeBytes(32));

/** `vaultTokenDomainSeparator(erc20)`: 32 bytes. `erc20` is `0x` + 40 hex. */
export const vaultTokenDomainSeparator = (erc20: string): Uint8Array => {
  const address = bytesOfHex(erc20.toLowerCase());
  if (address.length !== 20) throw new RangeError(`ERC20 address must be 20 bytes, got ${address.length}`);
  // `erc20Address as Field as Bytes<32>`: the 20 bytes as a (little-endian) Field, back to 32 bytes.
  const asField = convertBytesToUint(FIELD_MAX, 20, address, "Field", "bridge.ts vaultTokenDomainSeparator");
  return upgradeFromTransient(transientHash(HASH_INPUT, [pad(32, "erc20:vault:"), convertBigintToBytes(32, asField, "bridge.ts")]));
};

/** The shielded colour the vault mints for `erc20`: 64 lowercase hex. */
export const bridgedColour = (bridge: BridgeDef): string => rawTokenType(vaultTokenDomainSeparator(bridge.erc20), bridge.vault);

/**
 * Every token with a `bridge` must carry exactly the derived colour. Throws a
 * `LadderConfigError` naming the token and both colours.
 */
export const checkBridgedColours = (file: LadderFile, colours: Readonly<Record<string, string>>): void => {
  for (const [symbol, token] of Object.entries(file.tokens)) {
    if (token.bridge === undefined) continue;
    const derived = bridgedColour(token.bridge);
    if (colours[symbol] !== derived) {
      throw new LadderConfigError(
        `token ${symbol}: colour ${colours[symbol]} is not the vault's colour for ${token.bridge.erc20} ` +
          `(tokenType(vaultTokenDomainSeparator(erc20), ${token.bridge.vault}) = ${derived})`,
      );
    }
  }
};
