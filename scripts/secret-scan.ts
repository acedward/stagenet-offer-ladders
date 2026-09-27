/**
 * Secret scan: fails if any part of the funding mnemonic, or anything shaped like a
 * wallet secret, appears in the given directories. Prints only PASS or FAIL plus, on
 * FAIL, the offending file paths and the rule that matched (never the matched text).
 *
 *   FUNDING_WALLET_FILE=/secrets/stagenet bun scripts/secret-scan.ts <dir> [<dir> ...]
 *
 * Rules:
 * - mnemonic: any 3 consecutive words of the mnemonic, in order, in a file's lowercase
 *   word stream (any separators: spaces, quotes, commas, newlines);
 * - wallet-assignment: `WALLET=` followed by 12 or more words (a real assignment, not a
 *   `WALLET="<words>"` placeholder in documentation);
 * - hex-seed: a 128-hex-character run (a 64-byte BIP-39 seed in hex).
 *
 * Skips `.git/` and `node_modules/`; reads text files up to 50 MB.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readMnemonicFile } from "../src/wallet.ts";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.log("FAIL (no directory to scan)");
  process.exit(2);
}
const words = readMnemonicFile(process.env.FUNDING_WALLET_FILE?.trim() || "/secrets/stagenet").split(" ");
const triples = new Set<string>();
for (let i = 0; i + 2 < words.length; i++) triples.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);

const walletAssignment = /WALLET\s*=\s*["']?\s*(?:[A-Za-z]+\s+){11,}[A-Za-z]+/u;
const hexSeed = /(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/u;

const findings: string[] = [];
let scanned = 0;

const scanFile = (root: string, file: string): void => {
  const size = lstatSync(file).size;
  if (size > 50 * 1024 * 1024) return;
  const buffer = readFileSync(file);
  if (buffer.subarray(0, 8000).includes(0)) return; // binary
  const text = buffer.toString("utf8");
  scanned++;
  const where = `${root}:${relative(root, file)}`;
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

const walk = (root: string, directory: string): void => {
  for (const name of readdirSync(directory)) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) walk(root, path);
    else if (stats.isFile()) scanFile(root, path);
  }
};

for (const root of roots) walk(root, root);
if (findings.length === 0) {
  console.log(`PASS (${scanned} text files, ${roots.length} roots)`);
  process.exit(0);
}
console.log(`FAIL (${findings.length} findings)`);
for (const finding of findings) console.log(`  ${finding}`);
process.exit(1);
