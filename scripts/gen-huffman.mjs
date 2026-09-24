import { readFileSync, writeFileSync } from 'node:fs';

const text = readFileSync('/tmp/rfc7541.txt', 'utf8');
const lines = text.split('\n');
const start = lines.findIndex(l => l.includes('(  0)  |11111111|11000'));
const rows = [];
for (let i = start; i < start + 257; i++) {
  const line = lines[i];
  const m = line.match(/^\s*\(\s*(\d+)\).*?\|\s*([0-9a-f]+)\s*\[(\d+)\]\s*$/);
  if (!m) throw new Error('cannot parse: ' + line);
  rows.push({ sym: Number(m[1]), hex: m[2], len: Number(m[3]) });
}
if (rows.length !== 257 || rows[256].sym !== 256) throw new Error('bad rows');
// sanity: '/' sym 47 should be 0x18 len 6
const slash = rows[47];
if (slash.hex !== '18' || slash.len !== 6) throw new Error('slash mismatch: ' + JSON.stringify(slash));

const compact = rows.map(r => `[${r.hex},${r.len}]`).join(',');
const out = `// 由 scripts/gen-huffman.mjs 从 RFC 7541 附录 B 生成。每项: [codeHexLSB, bitLength]
// 解码用：canonical 表，索引 0..255 为字节符号，256 为 EOS。
export const HUFFMAN_TABLE: ReadonlyArray<readonly [number, number]> = [
${compact}
];
`;
writeFileSync('src/shared/huffman-table.ts', out);
console.log('wrote', rows.length, 'entries');
