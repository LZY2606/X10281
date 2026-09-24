// HPACK 解码（RFC 7541）。动态表按方向隔离，由 replay 层为每个方向持有实例。
// 单位：header table size / max size 均为 octet。每次结构性变化产出新的 tableVersion。

export interface HeaderField {
  name: string;
  value: string;
  /** 原始表示保留标记：name/value 无法在导入时转换时留原值并附诊断 */
  nameRawHex?: string;
  valueRawHex?: string;
}

export type HeaderOrigin =
  | { kind: 'indexed'; index: number; table: 'static' | 'dynamic'; dynamicVersion?: number; entryPos?: number }
  | { kind: 'literal-incremental'; nameIndex?: number; nameTable?: 'static' | 'dynamic'; dynamicVersion?: number; insertedPos?: number }
  | { kind: 'literal-without-indexing'; nameIndex?: number; nameTable?: 'static' | 'dynamic' }
  | { kind: 'literal-never-indexed'; nameIndex?: number; nameTable?: 'static' | 'dynamic' }
  | { kind: 'size-update'; newMaxOctets: number };

export interface DecodedHeader {
  field: HeaderField;
  origin: HeaderOrigin;
  /** 该 header 在 header block 内的序号 */
  ordinal: number;
  /** 在 header block 字节流中的坐标 [start,end)，单位 octet */
  byteRange: [number, number];
}

export interface TableSnapshot {
  version: number;
  entries: { pos: number; name: string; value: string; insertedByBlockSeq: number }[];
  sizeOctets: number;
  maxOctets: number;
}

export class HpackError extends Error {
  code: 'INDEX_OOB' | 'TABLE_SIZE_UPDATE' | 'ENCODING';
  offsetOctets: number;
  constructor(code: HpackError['code'], message: string, offsetOctets: number) {
    super(message);
    this.code = code;
    this.offsetOctets = offsetOctets;
  }
}

export interface DecodeOptions {
  /** 当前方向“已生效”的 SETTINGS_HEADER_TABLE_SIZE 上限（确认点之后） */
  confirmedMaxOctets: number;
  /**
   * 候选上限：SETTINGS 已收到但 ACK 生效点未到时，保留全部合法解释。
   * 空数组表示只有 confirmed 一个候选。
   */
  candidateMaxOctets?: number[];
  blockSeq: number;
}

export interface DecodeResult {
  headers: DecodedHeader[];
  /** 解码结束后各候选上限对应的动态表版本（未被采纳的候选同样保留） */
  outcomes: {
    maxOctets: number;
    adopted: boolean;
    snapshot: TableSnapshot;
    headers: DecodedHeader[];
    error?: { code: 'INDEX_OOB' | 'TABLE_SIZE_UPDATE' | 'ENCODING'; message: string; offsetOctets: number };
  }[];
  diagnostics: { message: string; offsetOctets: number }[];
}

export const STATIC_TABLE: HeaderField[] = [
  { name: ':authority', value: '' },
  { name: ':path', value: '/' },
  { name: ':path', value: '/index.html' },
  { name: ':method', value: 'GET' },
  { name: ':method', value: 'POST' },
  { name: ':status', value: '200' },
  { name: ':status', value: '204' },
  { name: ':status', value: '206' },
  { name: ':status', value: '304' },
  { name: ':status', value: '400' },
  { name: ':status', value: '404' },
  { name: ':status', value: '500' },
  { name: 'accept-charset', value: '' },
  { name: 'accept-encoding', value: 'gzip, deflate' },
  { name: 'accept-language', value: '' },
  { name: 'accept-ranges', value: '' },
  { name: 'accept', value: '' },
  { name: 'access-control-allow-origin', value: '' },
  { name: 'age', value: '' },
  { name: 'allow', value: '' },
  { name: 'authorization', value: '' },
  { name: 'cache-control', value: '' },
  { name: 'content-disposition', value: '' },
  { name: 'content-encoding', value: '' },
  { name: 'content-language', value: '' },
  { name: 'content-length', value: '' },
  { name: 'content-location', value: '' },
  { name: 'content-range', value: '' },
  { name: 'content-type', value: '' },
  { name: 'cookie', value: '' },
  { name: 'date', value: '' },
  { name: 'etag', value: '' },
  { name: 'expect', value: '' },
  { name: 'expires', value: '' },
  { name: 'from', value: '' },
  { name: 'host', value: '' },
  { name: 'if-match', value: '' },
  { name: 'if-modified-since', value: '' },
  { name: 'if-none-match', value: '' },
  { name: 'if-range', value: '' },
  { name: 'if-unmodified-since', value: '' },
  { name: 'last-modified', value: '' },
  { name: 'link', value: '' },
  { name: 'location', value: '' },
  { name: 'max-forwards', value: '' },
  { name: 'proxy-authenticate', value: '' },
  { name: 'proxy-authorization', value: '' },
  { name: 'range', value: '' },
  { name: 'referer', value: '' },
  { name: 'refresh', value: '' },
  { name: 'retry-after', value: '' },
  { name: 'server', value: '' },
  { name: 'set-cookie', value: '' },
  { name: 'strict-transport-security', value: '' },
  { name: 'transfer-encoding', value: '' },
  { name: 'user-agent', value: '' },
  { name: 'vary', value: '' },
  { name: 'via', value: '' },
  { name: 'www-authenticate', value: '' },
  { name: ':scheme', value: 'http' },
  { name: ':scheme', value: 'https' },
];

const ENTRY_OVERHEAD_OCTETS = 32;

interface DynEntry {
  name: string;
  value: string;
  insertedByBlockSeq: number;
  /** 插入时动态表版本（1-based 结构序号） */
  versionAtInsert: number;
}

/** 单个方向的 HPACK 动态表状态镜 */
export class HpackTable {
  private entries: DynEntry[] = [];
  private sizeOctets = 0;
  version = 0;
  maxOctets: number;
  readonly direction: 'c2s' | 's2c';

  constructor(direction: 'c2s' | 's2c', maxOctets = 4096) {
    this.direction = direction;
    this.maxOctets = maxOctets;
  }

  clone(): HpackTable {
    const t = new HpackTable(this.direction, this.maxOctets);
    t.entries = this.entries.map((e) => ({ ...e }));
    t.sizeOctets = this.sizeOctets;
    t.version = this.version;
    return t;
  }

  snapshot(): TableSnapshot {
    return {
      version: this.version,
      maxOctets: this.maxOctets,
      sizeOctets: this.sizeOctets,
      entries: this.entries.map((e, i) => ({ pos: i + 1, name: e.name, value: e.value, insertedByBlockSeq: e.insertedByBlockSeq })),
    };
  }

  /** 1-based 全表索引：1..61 静态表，其后动态表（最新在前） */
  lookup(index: number): { table: 'static' | 'dynamic'; field: HeaderField; entryPos?: number; dynamicVersion?: number } {
    if (index < 1) throw new HpackError('INDEX_OOB', `index 0 is invalid (RFC 7541 §6.1)`, -1);
    if (index <= STATIC_TABLE.length) {
      return { table: 'static', field: STATIC_TABLE[index - 1]! };
    }
    const dynPos = index - STATIC_TABLE.length;
    if (dynPos > this.entries.length) {
      throw new HpackError('INDEX_OOB', `index ${index} exceeds dynamic table length ${this.entries.length} in ${this.direction} direction`, -1);
    }
    const e = this.entries[dynPos - 1]!;
    return { table: 'dynamic', field: { name: e.name, value: e.value }, entryPos: dynPos, dynamicVersion: e.versionAtInsert };
  }

  private evictFor(needed: number, limit: number): void {
    while (this.sizeOctets + needed > limit && this.entries.length > 0) {
      const old = this.entries.pop()!;
      this.sizeOctets -= old.name.length + old.value.length + ENTRY_OVERHEAD_OCTETS;
    }
  }

  insert(field: HeaderField, blockSeq: number): number {
    const needed = field.name.length + field.value.length + ENTRY_OVERHEAD_OCTETS;
    if (needed > this.maxOctets) {
      // 单条大于上限时清空表（RFC 7541 §4.4）
      this.entries = [];
      this.sizeOctets = 0;
      this.version += 1;
      return 1;
    }
    this.evictFor(needed, this.maxOctets);
    this.version += 1;
    this.entries.unshift({ name: field.name, value: field.value, insertedByBlockSeq: blockSeq, versionAtInsert: this.version });
    this.sizeOctets += needed;
    return 1;
  }

  /** 动态表尺寸更新；超过给定上限即错误（上限由 SETTINGS 生效点决定，不在此混用） */
  applySizeUpdate(newMax: number, limit: number): void {
    if (newMax > limit) {
      throw new HpackError('TABLE_SIZE_UPDATE', `dynamic table size update ${newMax} octets exceeds effective limit ${limit} octets in ${this.direction}`, -1);
    }
    this.maxOctets = newMax;
    this.evictFor(0, newMax);
    this.version += 1;
  }
}

function readInt(buf: Uint8Array, offset: number, prefixBits: number): { value: number; next: number } {
  const mask = (1 << prefixBits) - 1;
  let i = offset;
  let value = buf[i]! & mask;
  if (value < mask) return { value, next: i + 1 };
  let m = 0;
  let b: number;
  do {
    i += 1;
    b = buf[i]!;
    value += (b & 0x7f) << m;
    m += 7;
  } while ((b & 0x80) === 0x80);
  return { value, next: i + 1 };
}

function readString(buf: Uint8Array, offset: number, prefixBits: number, diagnostics: { message: string; offsetOctets: number }[]): { field: HeaderField; next: number } {
  const h = buf[offset]!;
  const huffman = (h & 0x80) === 0x80;
  const len = readInt(buf, offset, prefixBits);
  const start = len.next;
  const raw = buf.subarray(start, start + len.value);
  let next = start + len.value;
  if (next > buf.length) {
    diagnostics.push({ message: `string length ${len.value} octets overruns header block (have ${buf.length - start} octets); raw bytes retained`, offsetOctets: start });
    next = Math.min(next, buf.length);
    return { field: { name: '', value: '', valueRawHex: Buffer.from(raw).toString('hex') }, next };
  }
  if (huffman) {
    // 本离线案例包不包含 Huffman 编码材料；无法转换时留在原位置并附诊断（不为展示丢弃）。
    diagnostics.push({ message: 'huffman-encoded string unsupported by this build; raw octets retained at origin', offsetOctets: offset });
    return { field: { name: '', value: '', valueRawHex: Buffer.from(raw).toString('hex') }, next };
  }
  return { field: { name: '', value: Buffer.from(raw).toString('utf8') }, next };
}

/**
 * 解码一个完整 header block（HEADERS + CONTINUATION 链拼接后的片段）。
 * 多候选上限：每个候选在克隆表上推进；非法候选产生 error 结果但保留。
 * 返回的 outcomes 覆盖“已确认上限”和所有候选解释，采纳标记由调用方按
 * SETTINGS ACK 生效点裁定。
 */
export function decodeBlock(base: HpackTable, block: Uint8Array, opts: DecodeOptions): DecodeResult {
  const limits = [opts.confirmedMaxOctets, ...(opts.candidateMaxOctets ?? [])];
  const distinct = [...new Set(limits)];
  const candidates = distinct.map((limit) => ({
    limit,
    table: base.clone(),
    headers: [] as DecodedHeader[],
    error: undefined as HpackError | undefined,
  }));
  const diagnostics: { message: string; offsetOctets: number }[] = [];
  let offset = 0;
  let ordinal = 0;

  while (offset < block.length) {
    const start = offset;
    const first = block[offset]!;
    if ((first & 0x80) === 0x80) {
      // 6.1 Indexed Header Field
      const r = readInt(block, offset, 7);
      offset = r.next;
      for (const c of candidates) {
        if (c.error) continue;
        try {
          const found = c.table.lookup(r.value);
          c.headers.push({ field: found.field, origin: { kind: 'indexed', index: r.value, table: found.table, dynamicVersion: found.dynamicVersion, entryPos: found.entryPos }, ordinal, byteRange: [start, offset] });
        } catch (e) {
          if (e instanceof HpackError) {
            e.offsetOctets = start;
            c.error = e;
          } else throw e;
        }
      }
      ordinal += 1;
    } else if ((first & 0xc0) === 0x40) {
      // 6.2.1 Literal with Incremental Indexing
      const nameR = readInt(block, offset, 6);
      offset = nameR.next;
      let field: HeaderField;
      let nameOrigin: { nameIndex?: number; nameTable?: 'static' | 'dynamic'; dynamicVersion?: number; insertedPos?: number } = {};
      if (nameR.value !== 0) {
        const found0 = base.lookup(nameR.value);
        nameOrigin = { nameIndex: nameR.value, nameTable: found0.table, dynamicVersion: found0.dynamicVersion };
        const val = readString(block, offset, 8, diagnostics);
        offset = val.next;
        field = { name: found0.field.name, value: val.field.value, valueRawHex: val.field.valueRawHex };
      } else {
        const nm = readString(block, offset, 8, diagnostics);
        offset = nm.next;
        const val = readString(block, offset, 8, diagnostics);
        offset = val.next;
        field = { name: nm.field.value, value: val.field.value, nameRawHex: nm.field.valueRawHex, valueRawHex: val.field.valueRawHex };
      }
      for (const c of candidates) {
        if (c.error) continue;
        try {
          if (nameR.value !== 0) {
            const found = c.table.lookup(nameR.value);
            field = { ...field, name: found.field.name };
          }
          c.table.insert(field, opts.blockSeq);
          c.headers.push({ field, origin: { kind: 'literal-incremental', ...nameOrigin, insertedPos: 1 }, ordinal, byteRange: [start, offset] });
        } catch (e) {
          if (e instanceof HpackError) {
            e.offsetOctets = start;
            c.error = e;
          } else throw e;
        }
      }
      ordinal += 1;
    } else if ((first & 0xe0) === 0x20) {
      // 6.3 Dynamic Table Size Update
      const r = readInt(block, offset, 5);
      offset = r.next;
      for (const c of candidates) {
        if (c.error) continue;
        try {
          c.table.applySizeUpdate(r.value, c.limit);
          c.headers.push({ field: { name: '', value: '' }, origin: { kind: 'size-update', newMaxOctets: r.value }, ordinal, byteRange: [start, offset] });
        } catch (e) {
          if (e instanceof HpackError) {
            e.offsetOctets = start;
            c.error = e;
          } else throw e;
        }
      }
      ordinal += 1;
    } else {
      // 6.2.2 / 6.2.3 Literal Without Indexing / Never Indexed
      const never = (first & 0xf0) === 0x10;
      const nameR = readInt(block, offset, 4);
      offset = nameR.next;
      let field: HeaderField;
      let nameOrigin: { nameIndex?: number; nameTable?: 'static' | 'dynamic'; dynamicVersion?: number } = {};
      if (nameR.value !== 0) {
        const found0 = base.lookup(nameR.value);
        nameOrigin = { nameIndex: nameR.value, nameTable: found0.table, dynamicVersion: found0.dynamicVersion };
        const val = readString(block, offset, 8, diagnostics);
        offset = val.next;
        field = { name: found0.field.name, value: val.field.value, valueRawHex: val.field.valueRawHex };
      } else {
        const nm = readString(block, offset, 8, diagnostics);
        offset = nm.next;
        const val = readString(block, offset, 8, diagnostics);
        offset = val.next;
        field = { name: nm.field.value, value: val.field.value, nameRawHex: nm.field.valueRawHex, valueRawHex: val.field.valueRawHex };
      }
      for (const c of candidates) {
        if (c.error) continue;
        if (nameR.value !== 0) {
          try {
            const found = c.table.lookup(nameR.value);
            field = { ...field, name: found.field.name };
          } catch (e) {
            if (e instanceof HpackError) {
              e.offsetOctets = start;
              c.error = e;
            } else throw e;
          }
        }
        if (!c.error) {
          c.headers.push({ field, origin: { kind: never ? 'literal-never-indexed' : 'literal-without-indexing', ...nameOrigin }, ordinal, byteRange: [start, offset] });
        }
      }
      ordinal += 1;
    }
  }

  const outcomes = candidates.map((c) => ({
    maxOctets: c.limit,
    adopted: c.limit === opts.confirmedMaxOctets,
    error: c.error ? { code: c.error.code, message: c.error.message, offsetOctets: c.error.offsetOctets } : undefined,
    headers: c.headers,
    snapshot: c.table.snapshot(),
  }));
  const adopted = outcomes.find((o) => o.adopted && !o.error) ?? outcomes[0]!;
  return { headers: adopted.headers, outcomes, diagnostics };
}
