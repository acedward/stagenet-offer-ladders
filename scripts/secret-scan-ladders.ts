/**
 * Secret scan for the ladder service: fails if any part of a maker mnemonic (and,
 * optionally, a funding mnemonic), or anything shaped like a wallet secret, appears in
 * the given paths. Prints only PASS or FAIL plus, on FAIL, the offending file paths and
 * the rule that matched — never the matched text.
 *
 *   MAKERS_FILE=/secrets/makers.json [FUNDING_WALLET_FILE=/secrets/stagenet] \
 *     bun scripts/secret-scan-ladders.ts <path> [<path> …]
 *
 * Rules (as 00052's `scripts/secret-scan.ts`, extended to every maker):
 * - mnemonic: any 3 consecutive words of any known mnemonic, in order, in a file's
 *   lowercase word stream (any separators);
 * - wallet-assignment: `WALLET=` followed by 12 or more words;
 * - hex-seed: a 128-hex-character run (a 64-byte BIP-39 seed in hex).
 *
 * Skips `.git/` and `node_modules/`, and the secrets files themselves; binary files are
 * skipped; text files up to 50 MB are read.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { readMakersFile, readMnemonicFile } from "../src/wallets.ts";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.log("FAIL (no path to scan)");
  process.exit(2);
}

const makersFile = process.env["MAKERS_FILE"]?.trim();
const fundingFile = process.env["FUNDING_WALLET_FILE"]?.trim();
const mnemonics: string[] = [];
const skip = new Set<string>();
if (makersFile) {
  for (const maker of readMakersFile(makersFile).makers) mnemonics.push(maker.mnemonic);
  skip.add(realpathSync(makersFile));
}
if (fundingFile) {
  mnemonics.push(readMnemonicFile(fundingFile));
  skip.add(realpathSync(fundingFile));
}
if (mnemonics.length === 0) {
  console.log("FAIL (no mnemonic source: set MAKERS_FILE and/or FUNDING_WALLET_FILE)");
  process.exit(2);
}
const triples = new Set<string>();
for (const mnemonic of mnemonics) {
  const words = mnemonic.split(" ");
  for (let i = 0; i + 2 < words.length; i++) triples.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
}

const walletAssignment = /WALLET\s*=\s*["']?\s*(?:[A-Za-z]+\s+){11,}[A-Za-z]+/u;
const hexSeed = /(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/u;

const findings: string[] = [];
let scanned = 0;

const scanFile = (root: string, file: string): void => {
  if (skip.has(realpathSync(file))) return;
  const size = lstatSync(file).size;
  if (size > 50 * 1024 * 1024) return;
  const buffer = readFileSync(file);
  if (buffer.subarray(0, 8000).includes(0)) return; // binary
  const text = buffer.toString("utf8");
  scanned++;
  const where = `${root}:${relative(root, file) || "."}`;
  const stream = ` ${text.toLowerCase().split(/[^a-z]+/u).filter(Boolean).join(" ")} `;
  for (const triple of triples) {
    if (stream.includes(` ${triple} `)) {
      findings.push(`${where} [mnemonic]`);
      break;
    }
  }
  if (walletAssignment.test(text)) findings.push(`${where} [wallet-assignment]`);
  if (hexSeed.test(text)) findings.push(`${where} [hex-seed]`);
};

const walk = (root: string, path: string): void => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isFile()) {
    scanFile(root, path);
    return;
  }
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(path)) {
    if (name === ".git" || name === "node_modules") continue;
    walk(root, join(path, name));
  }
};

for (const root of roots) {
  if (!existsSync(root)) {
    findings.push(`${root} [missing path]`);
    continue;
  }
  walk(root, root);
}
if (findings.length === 0) {
  console.log(`PASS (${scanned} text files, ${roots.length} paths, ${mnemonics.length} mnemonics)`);
  process.exit(0);
}
console.log(`FAIL (${findings.length} findings)`);
for (const finding of findings) console.log(`  ${finding}`);
process.exit(1);
