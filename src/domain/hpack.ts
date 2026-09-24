/**
 * HPACK（RFC 7541）最小解码器与按方向隔离的动态表。
 * - 静态表见 Appendix A（61 项）。
 * - Huffman 字符串不做翻译：保留原字节 + HUFFMAN_UNSUPPORTED 诊断，
 *   绝不为了画图而丢弃（无法转换的值留在原位置）。
 * - 动态表 size/maxSize 单位均为 byte，坐标基准 RFC 7541 §4.1 entry size。
 */
import { q, BASIS, UNIT } from './units.ts';

export interface TableEntry {
  name: string;
  value: string;
  entrySize: number;
}

export interface StringRep {
  text: string | null;
  rawHex: string;
  huffman: boolean;
  diagnosticCode: string | null;
}

export type FieldOrigin =
  | 'static-index'
  | 'dynamic-index'
  | 'literal-name-indexed'
  | 'literal-name-literal';

export interface DecodedField {
  name: StringRep;
  value: StringRep;
  origin: FieldOrigin;
  /** 命中索引（static/dynamic 统一编号，1 起） */
  refIndex: number | null;
  /** 索引命中时所引用的动态表版本 slug */
  refTableVersion: string | null;
  /** 增量索引后新条目落入的动态表版本 slug（由回放层回填） */
  addedTableVersion: string | null;
}

export interface HpackViolation {
  code: 'HPACK_INDEX_OUT_OF_BOUNDS' | 'HPACK_DYNAMIC_SIZE_EXCEEDS' | 'HPACK_INDEX_ZERO' | 'HPACK_TRUNCATED';
  message: string;
  offset: number;
}

export interface DecodeResult {
  fields: DecodedField[];
  violations: HpackViolation[];
  /** size update 序列（即使被拒绝也记录，供 SETTINGS 生效点裁决） */
  sizeUpdates: { requested: number; applied: boolean; capAtPoint: number }[];
  /** 解码后动态表是否发生变化 */
  tableMutated: boolean;
  consumedBytes: number;
}

export const STATIC_TABLE: ReadonlyArray<readonly [string, string]> = [
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

export function entrySize(name: string, value: string): number {
  return 32 + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
}

/** 按方向隔离的动态表：每个连接方向一个实例，索引空间互不可见。 */
export class DynamicTable {
  entries: TableEntry[] = []; // entries[0] 为最新
  sizeBytes = 0;
  /** 当前上限（byte）。由该方向上“已生效”的对端 SETTINGS_HEADER_TABLE_SIZE 决定。 */
  maxSizeBytes: number;
  version = 0;

  constructor(initialMaxSizeBytes = 4096) {
    this.maxSizeBytes = initialMaxSizeBytes;
  }

  totalLength(): number {
    return STATIC_TABLE.length + this.entries.length;
  }

  lookup(index1: number): { entry: TableEntry; inDynamic: boolean } | null {
    if (index1 < 1 || index1 > this.totalLength()) return null;
    if (index1 <= STATIC_TABLE.length) {
      const [name, value] = STATIC_TABLE[index1 - 1];
      return { entry: { name, value, entrySize: 0 }, inDynamic: false };
    }
    return { entry: this.entries[index1 - STATIC_TABLE.length - 1], inDynamic: true };
  }

  add(name: string, value: string): void {
    const size = entrySize(name, value);
    if (size > this.maxSizeBytes) {
      this.entries = [];
      this.sizeBytes = 0;
      return;
    }
    this.entries.unshift({ name, value, entrySize: size });
    this.sizeBytes += size;
    while (this.sizeBytes > this.maxSizeBytes && this.entries.length > 0) {
      const evicted = this.entries.pop()!;
      this.sizeBytes -= evicted.entrySize;
    }
  }

  setMaxSize(max: number): void {
    this.maxSizeBytes = max;
    while (this.sizeBytes > this.maxSizeBytes && this.entries.length > 0) {
      const evicted = this.entries.pop()!;
      this.sizeBytes -= evicted.entrySize;
    }
  }

  snapshot(): {
    entries: { name: string; value: string; entrySize: { v: number; u: string; b: string } }[];
    size: { v: number; u: string; b: string };
    maxSize: { v: number; u: string; b: string };
  } {
    return {
      entries: this.entries.map((e) => ({
        name: e.name,
        value: e.value,
        entrySize: q(e.entrySize, UNIT.TABLE_SIZE_BYTES, BASIS.RFC7541_ENTRY),
      })),
      size: q(this.sizeBytes, UNIT.TABLE_SIZE_BYTES, BASIS.RFC7541_ENTRY),
      maxSize: q(this.maxSizeBytes, UNIT.TABLE_SIZE_BYTES, BASIS.RFC7541_ENTRY),
    };
  }
}

function decodeInteger(
  buf: Buffer,
  start: number,
  prefixBits: number,
): { value: number; next: number } | null {
  const mask = (1 << prefixBits) - 1;
  let value = buf[start] & mask;
  let i = start + 1;
  if (value < mask) return { value, next: i };
  let m = 0;
  let b: number;
  do {
    if (i >= buf.length) return null;
    b = buf[i];
    value += (b & 127) * 2 ** m;
    m += 7;
    i++;
  } while (b & 128);
  return { value, next: i };
}

function decodeString(buf: Buffer, start: number): StringRep & { next: number } | null {
  if (start >= buf.length) return null;
  const first = buf[start];
  const huffman = (first & 0x80) !== 0;
  const len = decodeInteger(buf, start, 7);
  if (!len) return null;
  const raw = buf.subarray(len.next, len.next + len.value);
  const rawHex = raw.toString('hex');
  if (len.next + len.value > buf.length) {
    return {
      text: null,
      rawHex,
      huffman,
      diagnosticCode: 'HPACK_STRING_TRUNCATED',
      next: buf.length,
    };
  }
  if (huffman) {
    // 不做 Huffman 翻译：保留原始表示并附诊断。
    return {
      text: null,
      rawHex,
      huffman: true,
      diagnosticCode: 'HUFFMAN_UNSUPPORTED',
      next: len.next + len.value,
    };
  }
  return {
    text: raw.toString('utf8'),
    rawHex,
    huffman: false,
    diagnosticCode: null,
    next: len.next + len.value,
  };
}

function mkString(text: string): StringRep {
  return {
    text,
    rawHex: Buffer.from(text, 'utf8').toString('hex'),
    huffman: false,
    diagnosticCode: null,
  };
}

/**
 * 解码一个完整的 header block（HEADERS + CONTINUATION 链重组后）。
 * @param table 该方向的动态表
 * @param capAtPoint 该 block 起始时刻“已生效”的动态表大小上限（byte）
 */
export function decodeHeaderBlock(
  blockBuf: Buffer,
  table: DynamicTable,
  capAtPoint: number,
  refVersionSlug: string,
): DecodeResult {
  const res: DecodeResult = {
    fields: [],
    violations: [],
    sizeUpdates: [],
    tableMutated: false,
    consumedBytes: 0,
  };
  let i = 0;
  const buf = blockBuf;

  const litFromIndex = (
    idx: number,
    next: number,
    indexing: 'none' | 'incremental',
  ): number => {
    let nameRep: StringRep;
    let valueRep: StringRep;
    let origin: FieldOrigin;
    let refIndex: number | null = null;
    if (idx === 0) {
      const n = decodeString(buf, next);
      if (!n) {
        res.violations.push({ code: 'HPACK_TRUNCATED', message: '字面量名不完整', offset: i });
        return buf.length;
      }
      const v = decodeString(buf, n.next);
      if (!v) {
        res.violations.push({ code: 'HPACK_TRUNCATED', message: '字面量值不完整', offset: i });
        return buf.length;
      }
      nameRep = { text: n.text, rawHex: n.rawHex, huffman: n.huffman, diagnosticCode: n.diagnosticCode };
      valueRep = { text: v.text, rawHex: v.rawHex, huffman: v.huffman, diagnosticCode: v.diagnosticCode };
      origin = 'literal-name-literal';
      next = v.next;
    } else {
      const hit = table.lookup(idx);
      if (!hit) {
        res.violations.push({
          code: 'HPACK_INDEX_OUT_OF_BOUNDS',
          message: `字面量名索引 ${idx} 越界（表长 ${table.totalLength()}）`,
          offset: i,
        });
        return buf.length;
      }
      const v = decodeString(buf, next);
      if (!v) {
        res.violations.push({ code: 'HPACK_TRUNCATED', message: '字面量值不完整', offset: i });
        return buf.length;
      }
      nameRep = mkString(hit.entry.name);
      valueRep = { text: v.text, rawHex: v.rawHex, huffman: v.huffman, diagnosticCode: v.diagnosticCode };
      origin = 'literal-name-indexed';
      refIndex = idx;
      next = v.next;
    }
    const field: DecodedField = {
      name: nameRep,
      value: valueRep,
      origin,
      refIndex,
      refTableVersion: refIndex !== null ? refVersionSlug : null,
      addedTableVersion: null,
    };
    res.fields.push(field);
    if (indexing === 'incremental' && nameRep.text !== null && valueRep.text !== null) {
      table.add(nameRep.text, valueRep.text);
      field.addedTableVersion = 'pending';
      res.tableMutated = true;
    }
    return next;
  };

  while (i < buf.length) {
    const b = buf[i];
    if (b & 0x80) {
      const idx = decodeInteger(buf, i, 7);
      if (!idx) {
        res.violations.push({ code: 'HPACK_TRUNCATED', message: '索引表示不完整', offset: i });
        break;
      }
      i = idx.next;
      if (idx.value === 0) {
        res.violations.push({ code: 'HPACK_INDEX_ZERO', message: '索引 0 在 indexed 表示中非法', offset: i });
        break;
      }
      const hit = table.lookup(idx.value);
      if (!hit) {
        res.violations.push({
          code: 'HPACK_INDEX_OUT_OF_BOUNDS',
          message: `索引 ${idx.value} 越界（表长 ${table.totalLength()}：static 61 + dynamic ${table.entries.length}）`,
          offset: i,
        });
        break;
      }
      res.fields.push({
        name: mkString(hit.entry.name),
        value: mkString(hit.entry.value),
        origin: hit.inDynamic ? 'dynamic-index' : 'static-index',
        refIndex: idx.value,
        refTableVersion: hit.inDynamic ? refVersionSlug : null,
        addedTableVersion: null,
      });
      continue;
    }
    if ((b & 0xe0) === 0x20) {
      const size = decodeInteger(buf, i, 5);
      if (!size) {
        res.violations.push({ code: 'HPACK_TRUNCATED', message: '动态表大小更新不完整', offset: i });
        break;
      }
      i = size.next;
      const allowed = size.value <= capAtPoint;
      res.sizeUpdates.push({ requested: size.value, applied: allowed, capAtPoint });
      if (!allowed) {
        res.violations.push({
          code: 'HPACK_DYNAMIC_SIZE_EXCEEDS',
          message: `动态表大小更新请求 ${size.value} byte 超过本生效点上限 ${capAtPoint} byte（SETTINGS 确认前后上限不得混用）`,
          offset: i,
        });
        continue;
      }
      table.setMaxSize(size.value);
      res.tableMutated = true;
      continue;
    }
    if ((b & 0xc0) === 0x40) {
      const idx = decodeInteger(buf, i, 6);
      if (!idx) {
        res.violations.push({ code: 'HPACK_TRUNCATED', message: '增量索引表示不完整', offset: i });
        break;
      }
      i = litFromIndex(idx.value, idx.next, 'incremental');
      continue;
    }
    const prefixBits = (b & 0xf0) === 0x10 ? 4 : 4;
    const idx = decodeInteger(buf, i, prefixBits);
    if (!idx) {
      res.violations.push({ code: 'HPACK_TRUNCATED', message: '字面量表示不完整', offset: i });
      break;
    }
    i = litFromIndex(idx.value, idx.next, 'none');
  }
  res.consumedBytes = i;
  return res;
}
