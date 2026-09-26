/**
 * Redaction for error text that reaches logs and the journal (audit C16): drops any run
 * of 12 or more English BIP-39 words, 128-hex runs (seeds), and 64-hex values that follow
 * a key/secret/seed/mnemonic word. Public ids (offer ids, colours, nonces) are left alone.
 *
 * @module
 */
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

const WORDS = new Set(english);

export const redact = (text: string): string => {
  let out = String(text).replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/gu, "[REDACTED-HEX]");
  out = out.replace(/\b(key|secret|seed|mnemonic|private)(\W{1,4})([0-9a-fA-F]{64})\b/giu, "$1$2[REDACTED-HEX]");
  const tokens = out.split(/(\s+)/u);
  const words = tokens.map((t) => WORDS.has(t.toLowerCase().replace(/[^a-z]/gu, "")) && /^[a-zA-Z"',.]+$/u.test(t));
  let result = "";
  for (let i = 0; i < tokens.length; ) {
    if (words[i]) {
      let j = i;
      let count = 0;
      while (j < tokens.length && (words[j] || /^\s+$/u.test(tokens[j]!))) {
        if (words[j]) count += 1;
        j += 1;
      }
      result += count >= 12 ? "[REDACTED-WORDS]" : tokens.slice(i, j).join("");
      i = j;
    } else {
      result += tokens[i];
      i += 1;
    }
  }
  return result;
};
