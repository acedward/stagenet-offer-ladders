/**
 * Redaction for text that leaves the process (logs, JSON output) or reaches the journal
 * (audit C16, F-B23 / F-A22). It removes:
 * - any run of 12 or more English BIP-39 words, whatever joins them (spaces, commas, quotes,
 *   hyphens, brackets: `a b c`, `a,b,c`, `["a","b"]`, `a-b-c`);
 * - 128-hex runs (64-byte seeds);
 * - 64-hex values that follow a key/secret/seed/mnemonic/private word;
 * - signing-key JSON objects (`{"tag":"schnorr","value":"<64 hex>"}`).
 * Public ids (offer ids, colours, nonces, addresses) are left alone.
 *
 * @module
 */
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

const WORDS = new Set(english);
const JOINER = /^[\s,;:"'`\-\[\]\\]{1,8}$/u;

const redactWordRuns = (text: string): string => {
  const matches = [...text.matchAll(/[A-Za-z]+/gu)];
  const cut: [number, number][] = [];
  let runStart = -1;
  let runEnd = -1;
  let count = 0;
  const flush = (): void => {
    if (count >= 12) cut.push([runStart, runEnd]);
    runStart = -1;
    count = 0;
  };
  for (const m of matches) {
    const word = m[0].toLowerCase();
    const start = m.index!;
    const end = start + m[0].length;
    if (!WORDS.has(word)) {
      flush();
      continue;
    }
    if (count > 0 && JOINER.test(text.slice(runEnd, start))) {
      runEnd = end;
      count += 1;
    } else {
      flush();
      runStart = start;
      runEnd = end;
      count = 1;
    }
  }
  flush();
  let out = text;
  for (const [a, b] of cut.reverse()) out = `${out.slice(0, a)}[REDACTED-WORDS]${out.slice(b)}`;
  return out;
};

export const redact = (text: string): string => {
  let out = String(text).replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/gu, "[REDACTED-HEX]");
  out = out.replace(/"tag"\s*:\s*"(?:schnorr|ecdsa)"\s*,\s*"value"\s*:\s*"[0-9a-fA-F]{64}"/gu, '"tag":"[REDACTED]","value":"[REDACTED-KEY]"');
  out = out.replace(/\b(key|secret|seed|mnemonic|private)(\W{1,4})([0-9a-fA-F]{64})\b/giu, "$1$2[REDACTED-HEX]");
  return redactWordRuns(out);
};
