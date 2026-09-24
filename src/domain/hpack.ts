/**
 * HPACK (RFC 7541) 编解码。
 * 动态表按方向隔离：每个 Decoder/Encoder 实例只服务一个方向。
 */
import { HUFFMAN_CODES } from './huffman-table.ts';
import type { DecodedHeader, DynamicTableVersion } from './types.ts';
import { qty } from './types.ts';

export class HpackError extends Error {
  constructor(
    message: string,
    readonly code: 'COMPRESSION_ERROR' | 'BUFFER_UNDERFLOW' = 'COMPRESSION_ERROR',
  ) {
    super(message);
    this.name = 'HpackError';
  }
}

/* ---------- 整数编解码 (RFC 7541 §5.1) ---------- */

export function decodeInteger(buf: Uint8Array, offset: number, prefixBits: number): { value: number; nextOffset: number } {
  if (offset >= buf.length) throw new HpackError('integer: buffer underflow', 'BUFFER_UNDERFLOW');
  const mask = (1 << prefixBits) - 1;
  let value = buf[offset] & mask;
  let next = offset + 1;
  if (value < mask) return { value, nextOffset: next };
  let shift = 0;
  for (;;) {
    if (next >= buf.length) throw new HpackError('integer: truncated continuation', 'BUFFER_UNDERFLOW');
    const b = buf[next++];
    if (shift > 28) throw new HpackError('integer: overflow');
    value += (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, nextOffset: next };
}

export function encodeInteger(value: number, prefixBits: number, firstByteFlags: number): number[] {
  const mask = (1 << prefixBits) - 1;
  if (value < mask) return [firstByteFlags | value];
  const out = [firstByteFlags | mask];
  let rest = value - mask;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
  return out;
}

/* ---------- Huffman (RFC 7541 Appendix B) ---------- */

interface HuffNode { sym: number; children: [HuffNode | null, HuffNode | null] | null }

let huffRoot: HuffNode | null = null;
function root(): HuffNode {
  if (huffRoot) return huffRoot;
  huffRoot = { sym: -1, children: [null, null] };
  for (const [sym, code, len] of HUFFMAN_CODES) {
    let node = huffRoot;
    for (let i = len - 1; i >= 0; i--) {
      const bit = (code >>> i) & 1;
      if (!node.children) throw new Error('huffman table conflict');
      if (!node.children[bit]) node.children[bit] = { sym: -1, children: [null, null] };
      node = node.children[bit]!;
    }
    node.sym = sym;
    node.children = null;
  }
  return huffRoot;
}

/** 解码 Huffman 字符串。EOS 符号或非法填充抛出 HpackError。 */
export function huffmanDecode(buf: Uint8Array): Uint8Array {
  const r = root();
  const out: number[] = [];
  let node = r;
  let tailBits = 0; // 当前未落符号的尾随 1 位数（用于校验填充）
  let pending = 0;  // 当前路径已消费的比特数
  for (const byte of buf) {
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >>> i) & 1;
      if (!node.children) throw new HpackError('huffman: invalid state');
      const next = node.children[bit];
      if (!next) throw new HpackError('huffman: invalid code path');
      node = next;
      pending++;
      tailBits = bit === 1 ? tailBits + 1 : 0;
      if (node.sym >= 0) {
        if (node.sym === 256) throw new HpackError('huffman: EOS symbol in string');
        out.push(node.sym);
        node = r;
        pending = 0;
        tailBits = 0;
      }
    }
  }
  // 填充必须是 EOS 前缀（全 1）且不超过 7 位
  if (pending > 7 || tailBits !== pending) throw new HpackError('huffman: invalid padding');
  return Uint8Array.from(out);
}

export function huffmanEncode(input: Uint8Array): Uint8Array {
  let bits = 0n;
  let nbits = 0;
  for (const b of input) {
    const [, code, len] = HUFFMAN_CODES[b];
    bits = (bits << BigInt(len)) | BigInt(code);
    nbits += len;
  }
  const pad = (8 - (nbits % 8)) % 8;
  if (pad > 0) {
    bits = (bits << BigInt(pad)) | ((1n << BigInt(pad)) - 1n);
    nbits += pad;
  }
  const out = new Uint8Array(nbits / 8);
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

/* ---------- 字符串字面量 (RFC 7541 §5.2) ---------- */

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

export function decodeString(buf: Uint8Array, offset: number): { value: string; nextOffset: number } {
  if (offset >= buf.length) throw new HpackError('string: buffer underflow', 'BUFFER_UNDERFLOW');
  const huffman = (buf[offset] & 0x80) !== 0;
  const { value: len, nextOffset } = decodeInteger(buf, offset, 7);
  const end = nextOffset + len;
  if (end > buf.length) throw new HpackError('string: truncated', 'BUFFER_UNDERFLOW');
  const raw = buf.subarray(nextOffset, end);
  const bytes = huffman ? huffmanDecode(raw) : raw;
  try {
    return { value: textDecoder.decode(bytes), nextOffset: end };
  } catch {
    throw new HpackError('string: invalid utf-8');
  }
}

export function encodeString(value: string, useHuffman: boolean): number[] {
  const bytes = textEncoder.encode(value);
  const payload = useHuffman ? huffmanEncode(bytes) : bytes;
  return [...encodeInteger(payload.length, 7, useHuffman ? 0x80 : 0x00), ...payload];
}

/* ---------- 静态表 (RFC 7541 Appendix A) ---------- */

export const STATIC_TABLE: ReadonlyArray<readonly [string, string]> = [
  [':authority', ''], [':method', 'GET'], [':method', 'POST'], [':path', '/'], [':path', '/index.html'],
  [':scheme', 'http'], [':scheme', 'https'], [':status', '200'], [':status', '204'], [':status', '206'],
  [':status', '304'], [':status', '400'], [':status', '404'], [':status', '500'],
  ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'], ['accept-language', ''], ['accept-ranges', ''],
  ['accept', ''], ['access-control-allow-origin', ''], ['age', ''], ['allow', ''], ['authorization', ''],
  ['cache-control', ''], ['content-disposition', ''], ['content-encoding', ''], ['content-language', ''],
  ['content-length', ''], ['content-location', ''], ['content-range', ''], ['content-type', ''],
  ['cookie', ''], ['date', ''], ['etag', ''], ['expect', ''], ['expires', ''], ['from', ''], ['host', ''],
  ['if-match', ''], ['if-modified-since', ''], ['if-none-match', ''], ['if-range', ''], ['if-unmodified-since', ''],
  ['last-modified', ''], ['link', ''], ['location', ''], ['max-forwards', ''], ['proxy-authenticate', ''],
  ['proxy-authorization', ''], ['range', ''], ['referer', ''], ['refresh', ''], ['retry-after', ''],
  ['server', ''], ['set-cookie', ''], ['strict-transport-security', ''], ['transfer-encoding', ''],
  ['user-agent', ''], ['vary', ''], ['via', ''], ['www-authenticate', ''],
];

/* ---------- 动态表（单向） ---------- */

const entrySize = (name: string, value: string) => textEncoder.encode(name).length + textEncoder.encode(value).length + 32;

export class DynamicTable {
  private entries: Array<{ name: string; value: string }> = [];
  private size = 0;
  version = 0;

  constructor(readonly maxSize: number) {}

  get length(): number { return this.entries.length; }
  get currentSize(): number { return this.size; }

  /** HPACK 组合索引：1..61 静态表，62.. 动态表（最新在前）。 */
  lookup(index: number): { name: string; value: string; where: 'static' | 'dynamic' } {
    if (index <= 0) throw new HpackError(`index ${index}: 非法索引（从 1 开始）`);
    if (index <= STATIC_TABLE.length) {
      const [name, value] = STATIC_TABLE[index - 1];
      return { name, value, where: 'static' };
    }
    const di = index - STATIC_TABLE.length - 1;
    if (di >= this.entries.length) {
      // 表索引越界：连接错误 COMPRESSION_ERROR
      throw new HpackError(`index ${index}: 超出动态表（动态表 ${this.entries.length} 项，最大合法索引 ${STATIC_TABLE.length + this.entries.length}）`);
    }
    return { ...this.entries[di], where: 'dynamic' };
  }

  insert(name: string, value: string): void {
    const sz = entrySize(name, value);
    if (sz > this.maxSize) {
      this.entries = [];
      this.size = 0;
    } else {
      this.entries.unshift({ name, value });
      this.size += sz;
      this.evict();
    }
    this.version++;
  }

  setMaxSize(maxSize: number): void {
    (this as { maxSize: number }).maxSize = maxSize;
    this.evict();
    this.version++;
  }

  private evict(): void {
    while (this.size > this.maxSize && this.entries.length > 0) {
      const e = this.entries.pop()!;
      this.size -= entrySize(e.name, e.value);
    }
  }

  snapshot(id: string, direction: 'c2s' | 's2c', causedBy: string): DynamicTableVersion {
    return {
      id,
      direction,
      version: this.version,
      entries: this.entries.map((e) => ({ ...e, size: qty(String(entrySize(e.name, e.value)), entrySize(e.name, e.value), 'octet') })),
      size: qty(String(this.size), this.size, 'octet'),
      maxSize: qty(String(this.maxSize), this.maxSize, 'octet'),
      causedBy,
    };
  }
}

/* ---------- 解码器 ---------- */

export interface DecodeResult {
  headers: DecodedHeader[];
  /** 解码过程中动态表版本变化次数 */
  tableMutations: number;
}

let headerSeq = 0;
export function resetHeaderSeq(v = 0): void { headerSeq = v; }

export class HpackDecoder {
  readonly table: DynamicTable;
  constructor(maxSize = 4096) { this.table = new DynamicTable(maxSize); }

  /** 解码一个完整 header block 片段（调用方负责拼好 CONTINUATION 链）。 */
  decode(block: Uint8Array, idPrefix: string, tableVersionId: () => string): DecodeResult {
    const headers: DecodedHeader[] = [];
    const startVersion = this.table.version;
    let off = 0;
    while (off < block.length) {
      const b = block[off];
      const mkId = () => `${idPrefix}:h${headerSeq++}`;
      if (b & 0x80) {
        // 索引表示 §6.1
        const { value: index, nextOffset } = decodeInteger(block, off, 7);
        const e = this.table.lookup(index);
        headers.push({
          id: mkId(), name: e.name, value: e.value,
          source: e.where === 'static'
            ? { kind: 'static-table', index }
            : { kind: 'dynamic-table', index, tableVersionId: tableVersionId() },
        });
        off = nextOffset;
      } else if ((b & 0xe0) === 0x20) {
        // 动态表大小更新 §6.3：必须出现在 header block 开头（在任何 header 之前）
        if (headers.length > 0) throw new HpackError('dynamic table size update 出现在 header 之后');
        const { value: newSize, nextOffset } = decodeInteger(block, off, 5);
        if (newSize > this.table.maxSize) {
          throw new HpackError(`动态表大小更新 ${newSize} 超过当前上限 ${this.table.maxSize}`);
        }
        this.table.setMaxSize(newSize);
        off = nextOffset;
      } else {
        // 字面量：0000(不索引) / 0001(不索引-永不) / 01(增量索引)
        const incremental = (b & 0xc0) === 0x40;
        const prefixBits = incremental ? 6 : 4;
        const { value: nameIndex, nextOffset } = decodeInteger(block, off, prefixBits);
        off = nextOffset;
        let name: string;
        let nameSource: { kind: 'static-table' | 'dynamic-table'; index: number } | undefined;
        if (nameIndex === 0) {
          const s = decodeString(block, off);
          name = s.value;
          off = s.nextOffset;
        } else {
          const e = this.table.lookup(nameIndex);
          name = e.name;
          nameSource = { kind: e.where === 'static' ? 'static-table' : 'dynamic-table', index: nameIndex };
        }
        const v = decodeString(block, off);
        off = v.nextOffset;
        if (incremental) this.table.insert(name, v.value);
        headers.push({
          id: mkId(), name, value: v.value,
          source: nameSource ? { kind: 'literal', nameSource } : { kind: 'literal' },
        });
      }
    }
    return { headers, tableMutations: this.table.version - startVersion };
  }
}

/* ---------- 编码器（用于构造案例固件） ---------- */

export class HpackEncoder {
  readonly table: DynamicTable;
  constructor(maxSize = 4096) { this.table = new DynamicTable(maxSize); }

  indexed(index: number): number[] {
    if (index > 0 && index <= STATIC_TABLE.length + this.table.length) {
      // 同步编码端动态表视图（仅当引用动态表项时无需变更）
    }
    return encodeInteger(index, 7, 0x80);
  }

  literalIncremental(name: string, value: string, huffman = false): number[] {
    this.table.insert(name, value);
    return [0x40, ...encodeString(name, huffman), ...encodeString(value, huffman)];
  }

  literalIncrementalNameIndex(nameIndex: number, value: string, huffman = false): number[] {
    const e = this.table.lookup(nameIndex);
    this.table.insert(e.name, value);
    return [...encodeInteger(nameIndex, 6, 0x40), ...encodeString(value, huffman)];
  }

  literalNoIndex(name: string, value: string, huffman = false): number[] {
    return [0x00, ...encodeString(name, huffman), ...encodeString(value, huffman)];
  }

  tableSizeUpdate(newSize: number): number[] {
    this.table.setMaxSize(newSize);
    return encodeInteger(newSize, 5, 0x20);
  }
}
