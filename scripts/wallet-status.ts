/**
 * Read-only funding-wallet status: sync against stagenet and print the PUBLIC identity
 * (addresses, public keys) and balances. Submits nothing.
 *
 *   FUNDING_WALLET_FILE=/secrets/stagenet bun scripts/wallet-status.ts [--derivation bip39|entropy] [--account N]
 *
 * The mnemonic file is read in this process only (see src/wallet.ts); nothing secret is
 * printed. Output: one JSON object on stdout; progress lines on stderr.
 */
import { takeFundingLock } from "../src/state.ts";
import { fetchLedgerParameters, stagenet, WalletSession, type SeedDerivation } from "../src/wallet.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const derivation = (argument("derivation") ?? "bip39") as SeedDerivation;
if (derivation !== "bip39" && derivation !== "entropy") throw new Error("--derivation must be bip39 or entropy");
const account = Number(argument("account") ?? "0");
const mnemonicFile = process.env.FUNDING_WALLET_FILE?.trim() || "/secrets/stagenet";
const log = (line: string): void => console.error(`[${new Date().toISOString()}] ${line}`);

const network = stagenet();
const { height, parameters } = await fetchLedgerParameters(network);
log(`ledger parameters from block ${height}`);
const started = Date.now();
// Audit C4: the funding wallet is shared; hold funding.lock like every other tool.
const fundingLock = takeFundingLock("wallet-status");
const session = await WalletSession.open({
  network,
  mnemonicFile,
  derivation,
  account,
  dustParameters: parameters.dust,
  syncTimeoutMs: 20 * 60 * 1000,
  log,
});
try {
  log(`wallet opened; unshielded ${session.identity.unshieldedAddress}`);
  const balances = await session.balances();
  const out = {
    at: new Date().toISOString(),
    derivation,
    account,
    ledgerParametersBlock: height,
    syncSeconds: Math.round((Date.now() - started) / 1000),
    identity: session.identity,
    night: { star: balances.night.toString(), night: Number(balances.night) / 1e6 },
    nightUtxos: balances.nightUtxos.map((u) => ({ ...u, value: u.value.toString() })),
    dust: { speck: balances.dust.toString(), dust: Number(balances.dust) / 1e15 },
    shielded: Object.fromEntries(
      Object.entries(balances.shielded).map(([colour, value]) => [
        colour,
        { value: value.toString(), coins: balances.shieldedCoins[colour] ?? 0 },
      ]),
    ),
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await session.close().catch(() => undefined);
  fundingLock.release();
}
process.exit(0);
