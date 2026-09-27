/**
 * Redaction for text that leaves the process (logs, JSON output) or reaches the journal
 * (audits C16, F-B23 / F-A22, F-B29). It removes:
 * - any run of 12 or more English BIP-39 words, whatever joins them: spaces, commas,
 *   quotes, brackets, hyphens, `_`, `.`, `/`, camelCase, and JSON escapes (`\n`, `\t`,
 *   `\"`, ` `);
 * - 128-hex runs (64-byte seeds);
 * - 64-hex values that follow a key/secret/seed/mnemonic/private word;
 * - signing-key JSON objects (`{"tag":"schnorr","value":"<64 hex>"}`), also when escaped.
 * Public ids (offer ids, colours, nonces, addresses) are left alone.
 *
 * @module
 */
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

const WORDS = new Set(english);
const JOINER = /^[\s,;:"'`\-\[\]\\_./]{0,8}$/u;

/** Same-length copy with JSON escapes blanked, so indices map back to the original. */
const unescaped = (text: string): string =>
  text.replace(/\\u[0-9a-fA-F]{4}/gu, "      ").replace(/\\[nrtbf"\\/]/gu, "  ");

const redactWordRuns = (text: string): string => {
  const plain = unescaped(text);
  const cut: [number, number][] = [];
  let runStart = -1;
  let runEnd = -1;
  let count = 0;
  const flush = (): void => {
    if (count >= 12) cut.push([runStart, runEnd]);
    count = 0;
  };
  // camelCase-aware words: "abandonAbility" → "abandon", "Ability"
  for (const m of plain.matchAll(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/gu)) {
    const word = m[0].toLowerCase();
    const start = m.index!;
    const end = start + m[0].length;
    if (!WORDS.has(word)) {
      flush();
      continue;
    }
    if (count > 0 && JOINER.test(plain.slice(runEnd, start))) {
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

const Q = String.raw`\\*"`;

export const redact = (text: string): string => {
  let out = String(text).replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/gu, "[REDACTED-HEX]");
  out = out.replace(
    new RegExp(`${Q}tag${Q}\\s*:\\s*${Q}(?:schnorr|ecdsa)${Q}\\s*,\\s*${Q}value${Q}\\s*:\\s*${Q}[0-9a-fA-F]{64}${Q}`, "gu"),
    '"tag":"[REDACTED]","value":"[REDACTED-KEY]"',
  );
  out = out.replace(/\b(key|secret|seed|mnemonic|private)(\W{1,6})([0-9a-fA-F]{64})\b/giu, "$1$2[REDACTED-HEX]");
  return redactWordRuns(out);
};

/** Redact every string inside a structured value (before it is serialised; audit F-B29). */
export const redactDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
};
