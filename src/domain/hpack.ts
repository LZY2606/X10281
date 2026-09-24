/**
 * HPACK 解码（RFC 7541）。
 * 动态表按连接方向隔离：每个方向各有一张表，各自带版本号。
 * 每个解码出的 header 都带来源（static / dynamic@版本 / literal）。
 */
import { HUFFMAN_BITS, HUFFMAN_CODES } from './huffman-table.js';
import type { Direction } from './frames.js';

export const STATIC_TABLE: Array<[string, string]> = [
  [':authority', ''],
  [':method', 'GET'],
  [':method', 'POST'],
  [':path', '/'],
  [':path', '/index.html'],
  [':scheme', 'http'],
  [':scheme', 'https'],
  [':status', '200'],
  [':status', '204'],
  [':status', '206'],
  [':status', '304'],
  [':status', '400'],
  [':status', '404'],
  [':status', '500'],
  ['accept-charset', ''],
  ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''],
  ['accept-ranges', ''],
  ['accept', ''],
  ['access-control-allow-origin', ''],
  ['age', ''],
  ['allow', ''],
  ['authorization', ''],
  ['cache-control', ''],
  ['content-disposition', ''],
  ['content-encoding', ''],
  ['content-language', ''],
  ['content-length', ''],
  ['content-location', ''],
  ['content-range', ''],
  ['content-type', ''],
  ['cookie', ''],
  ['date', ''],
  ['etag', ''],
  ['expect', ''],
  ['expires', ''],
  ['from', ''],
  ['host', ''],
  ['if-match', ''],
  ['if-modified-since', ''],
  ['if-none-match', ''],
  ['if-range', ''],
  ['if-unmodified-since', ''],
  ['last-modified', ''],
  ['link', ''],
  ['location', ''],
  ['max-forwards', ''],
  ['proxy-authenticate', ''],
  ['proxy-authorization', ''],
  ['range', ''],
  ['referer', ''],
  ['refresh', ''],
  ['retry-after', ''],
  ['server', ''],
  ['set-cookie', ''],
  ['strict-transport-security', ''],
  ['transfer-encoding', ''],
  ['user-agent', ''],
  ['vary', ''],
  ['via', ''],
  ['www-authenticate', ''],
];

export class HpackError extends Error {
  constructor(
    message: string,
    readonly code: 'TABLE_INDEX_OUT_OF_RANGE' | 'INTEGER_OVERFLOW' | 'HUFFMAN_INVALID' | 'TRUNCATED' | 'TABLE_SIZE_UPDATE_INVALID',
  ) {
    super(message);
    this.name = 'HpackError';
  }
}

export interface HeaderSource {
  kind: 'static' | 'dynamic' | 'literal';
  /** static/dynamic 时的表索引（1-based，HPACK 语义） */
  index?: number;
  /** dynamic 时的方向与表版本 */
  direction?: Direction;
  tableVersion?: number;
}

export interface DecodedHeader {
  name: string;
  value: string;
  source: HeaderSource;
}

export interface DynamicTableEntry {
  name: string;
  value: string;
  /** RFC 7541 §4.1：条目大小 = 名长 + 值长 + 32 octets */
  size: number;
}

export class DynamicTable {
  entries: DynamicTableEntry[] = [];
  size = 0;
  /** 每次结构变化（插入/驱逐/改上限）版本 +1 */
  version = 0;

  constructor(
    readonly direction: Direction,
    public maxSize: number,
  ) {}

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    this.evict();
    this.version++;
  }

  insert(name: string, value: string): void {
    const size = name.length + value.length + 32;
    this.entries.unshift({ name, value, size });
    this.size += size;
    this.evict();
    this.version++;
  }

  private evict(): void {
    while (this.size > this.maxSize && this.entries.length > 0) {
      const e = this.entries.pop()!;
      this.size -= e.size;
    }
  }

  /** HPACK 1-based 索引：1..61 静态，62.. 动态（最新为 62） */
  get(index: number): { name: string; value: string; source: HeaderSource } {
    if (index <= 0) throw new HpackError(`index ${index} <= 0`, 'TABLE_INDEX_OUT_OF_RANGE');
    if (index <= STATIC_TABLE.length) {
      const [name, value] = STATIC_TABLE[index - 1];
      return { name, value, source: { kind: 'static', index } };
    }
    const dyn = index - STATIC_TABLE.length;
    if (dyn > this.entries.length) {
      throw new HpackError(
        `index ${index} out of range: static=${STATIC_TABLE.length}, dynamic(${this.direction}@v${this.version})=${this.entries.length}`,
        'TABLE_INDEX_OUT_OF_RANGE',
      );
    }
    const e = this.entries[dyn - 1];
    return {
      name: e.name,
      value: e.value,
      source: { kind: 'dynamic', index, direction: this.direction, tableVersion: this.version },
    };
  }
}

/** 解码结果：header 列表 + 表版本轨迹 + 诊断（无法转换的值留在原位置） */
export interface DecodeResult {
  headers: DecodedHeader[];
  tableVersionAfter: number;
  diagnostics: Array<{ code: string; message: string; raw: unknown }>;
}

interface HuffNode {
  symbol?: number;
  children: Array<HuffNode | undefined>;
}

let huffRoot: HuffNode | undefined;
function huffmanTree(): HuffNode {
  if (huffRoot) return huffRoot;
  huffRoot = { children: [] };
  for (let sym = 0; sym < HUFFMAN_CODES.length; sym++) {
    const code = HUFFMAN_CODES[sym];
    const bits = HUFFMAN_BITS[sym];
    let node = huffRoot;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (code >>> i) & 1;
      node = node.children[bit] ??= { children: [] };
    }
    node.symbol = sym;
  }
  return huffRoot;
}

export function huffmanDecode(buf: Buffer): { text: string; diagnostics: Array<{ code: string; message: string; raw: unknown }> } {
  const root = huffmanTree();
  const out: number[] = [];
  const diagnostics: Array<{ code: string; message: string; raw: unknown }> = [];
  let node = root;
  let trailingOnes = 0;
  let pendingBits = 0;
  for (const byte of buf) {
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >>> i) & 1;
      pendingBits++;
      trailingOnes = bit ? trailingOnes + 1 : 0;
      const next = node.children[bit];
      if (!next) {
        diagnostics.push({ code: 'HUFFMAN_INVALID', message: 'invalid huffman code path; raw bytes kept', raw: buf.toString('hex') });
        return { text: buf.toString('latin1'), diagnostics };
      }
      node = next;
      if (node.symbol !== undefined) {
        if (node.symbol === 256) {
          diagnostics.push({ code: 'HUFFMAN_INVALID', message: 'EOS symbol in string; raw bytes kept', raw: buf.toString('hex') });
          return { text: buf.toString('latin1'), diagnostics };
        }
        out.push(node.symbol);
        node = root;
        pendingBits = 0;
        trailingOnes = 0;
      }
    }
  }
  // 结尾填充必须是 ≤7 个 1（EOS 前缀）
  if (pendingBits > 7 || (pendingBits > 0 && trailingOnes !== pendingBits)) {
    diagnostics.push({ code: 'HUFFMAN_INVALID', message: 'invalid huffman padding; raw bytes kept', raw: buf.toString('hex') });
    return { text: buf.toString('latin1'), diagnostics };
  }
  return { text: Buffer.from(out).toString('utf8'), diagnostics };
}

export function decodeInteger(buf: Buffer, pos: number, prefixBits: number): { value: number; next: number } {
  const mask = (1 << prefixBits) - 1;
  if (pos >= buf.length) throw new HpackError('integer truncated', 'TRUNCATED');
  let value = buf[pos] & mask;
  let next = pos + 1;
  if (value < mask) return { value, next };
  let shift = 0;
  for (;;) {
    if (next >= buf.length) throw new HpackError('integer continuation truncated', 'TRUNCATED');
    const b = buf[next++];
    value += (b & 0x7f) << shift;
    shift += 7;
    if (shift > 28) throw new HpackError('integer overflow', 'INTEGER_OVERFLOW');
    if ((b & 0x80) === 0) break;
  }
  return { value, next };
}

export function decodeString(
  buf: Buffer,
  pos: number,
): { text: string; next: number; diagnostics: Array<{ code: string; message: string; raw: unknown }> } {
  if (pos >= buf.length) throw new HpackError('string truncated', 'TRUNCATED');
  const huffman = (buf[pos] & 0x80) !== 0;
  const { value: len, next } = decodeInteger(buf, pos, 7);
  if (next + len > buf.length) throw new HpackError('string payload truncated', 'TRUNCATED');
  const raw = buf.subarray(next, next + len);
  if (!huffman) return { text: raw.toString('utf8'), next: next + len, diagnostics: [] };
  const r = huffmanDecode(raw);
  return { text: r.text, next: next + len, diagnostics: r.diagnostics };
}

/**
 * 解码一个完整 header block。table 为**该方向**的动态表（方向隔离）。
 * maxTableSizeLimit 为对端 SETTINGS 宣告的当前生效上限（由调用方按 SETTINGS 时机规则给出）。
 */
export function decodeHeaderBlock(block: Buffer, table: DynamicTable, maxTableSizeLimit: number): DecodeResult {
  const headers: DecodedHeader[] = [];
  const diagnostics: DecodeResult['diagnostics'] = [];
  let pos = 0;
  while (pos < block.length) {
    const b = block[pos];
    if (b & 0x80) {
      // indexed header field
      const { value: index, next } = decodeInteger(block, pos, 7);
      const e = table.get(index);
      headers.push({ name: e.name, value: e.value, source: e.source });
      pos = next;
    } else if ((b & 0xc0) === 0x40) {
      // literal with incremental indexing
      const { value: nameIndex, next } = decodeInteger(block, pos, 6);
      let name: string;
      let nameSource: HeaderSource | undefined;
      pos = next;
      if (nameIndex === 0) {
        const s = decodeString(block, pos);
        name = s.text;
        diagnostics.push(...s.diagnostics);
        pos = s.next;
      } else {
        const e = table.get(nameIndex);
        name = e.name;
        nameSource = e.source;
      }
      const v = decodeString(block, pos);
      diagnostics.push(...v.diagnostics);
      pos = v.next;
      table.insert(name, v.text);
      headers.push({
        name,
        value: v.text,
        source: { kind: 'literal', ...(nameSource ? { index: nameSource.index, direction: nameSource.direction } : {}) },
      });
    } else if ((b & 0xe0) === 0x20) {
      // dynamic table size update —— 不得超过当前生效上限（SETTINGS 时机规则由上层决定 limit）
      const { value: newSize, next } = decodeInteger(block, pos, 5);
      if (newSize > maxTableSizeLimit) {
        throw new HpackError(
          `table size update ${newSize} exceeds effective limit ${maxTableSizeLimit} (${table.direction}@v${table.version})`,
          'TABLE_SIZE_UPDATE_INVALID',
        );
      }
      table.setMaxSize(newSize);
      pos = next;
    } else {
      // literal without indexing / never indexed
      const prefixBits = (b & 0x10) !== 0 ? 4 : 4;
      const { value: nameIndex, next } = decodeInteger(block, pos, prefixBits);
      let name: string;
      pos = next;
      if (nameIndex === 0) {
        const s = decodeString(block, pos);
        name = s.text;
        diagnostics.push(...s.diagnostics);
        pos = s.next;
      } else {
        name = table.get(nameIndex).name;
      }
      const v = decodeString(block, pos);
      diagnostics.push(...v.diagnostics);
      pos = v.next;
      headers.push({ name, value: v.text, source: { kind: 'literal' } });
    }
  }
  return { headers, tableVersionAfter: table.version, diagnostics };
}
