// Generates src/domain/huffmanTable.ts from RFC 7541 Appendix B.
import { readFileSync, writeFileSync } from "node:fs";

const rfc = readFileSync("/tmp/rfc7541.txt", "utf8");
const rfc = readFileSync("/tmp/rfc7541.txt", "utf8");
const lines = rfc.split("\n");
const entries = [];
for (const line of lines) {
  if (!line.includes("|") || !/\[\s*\d+\]/.test(line)) continue;
  const sym = line.match(/^\s*(?:'(?:\\)?(.)'|EOS)?\s*\(\s*(\d+)\)\s*\|/);
  const tail = line.match(/([0-9a-f]+)\s*\[\s*(\d+)\]\s*$/);
  if (!sym || !tail) continue;
  const ordinal = Number(sym[2]);
  if (ordinal > 256) continue;
  entries[ordinal] = `[0x${BigInt("0x" + tail[1]).toString(16)}, ${Number(tail[2])}]`;
}
if (entries.length !== 257 || entries.some((e) => e === undefined)) {
  throw new Error("bad huffman table: " + entries.map((e, i) => (e ? null : i)).filter(Boolean).join(","));
}
const out = `// AUTO-GENERATED from RFC 7541 Appendix B by scripts/gen-huffman.mjs. Do not edit.
// Each entry is [code (LSB-aligned integer), length in bits] for symbols 0..256 (256 = EOS).
export const HUFFMAN_CODES: ReadonlyArray<readonly [number, number]> = [
${entries.map((e, i) => `  /* ${i} */ ${e},`).join("\n")}
];
`;
writeFileSync(new URL("../src/domain/huffmanTable.ts", import.meta.url), out);
console.log("wrote huffmanTable.ts with", entries.length, "entries");
