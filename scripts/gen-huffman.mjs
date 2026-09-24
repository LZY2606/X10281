import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync('/tmp/rfc7541.txt', 'utf8');
const start = text.indexOf('Appendix B.  Huffman Code');
const end = text.indexOf('Appendix C', start);
const section = text.slice(start, end);
const entries = [];
for (const line of section.split('\n')) {
  const m = line.match(/([0-9a-f]+)\s+\[\s*(\d+)\]\s*$/);
  if (m) entries.push([parseInt(m[1], 16), Number(m[2])]);
}
if (entries.length !== 257) throw new Error('expected 257 entries, got ' + entries.length);
const codes = entries.map(e => e[0]);
const bits = entries.map(e => e[1]);
const out = `// Generated from RFC 7541 Appendix B by scripts/gen-huffman.mjs. Do not edit by hand.
export const HUFFMAN_CODES: number[] = [${codes.join(',')}];
export const HUFFMAN_BITS: number[] = [${bits.join(',')}];
`;
writeFileSync('src/domain/huffman-table.ts', out);
console.log('entries:', entries.length, 'sym48:', entries[48], 'sym256:', entries[256]);
