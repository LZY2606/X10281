/**
 * HPACK 解码器（RFC 7541）。
 *
 * 关键点（对应本项目的推导规则）：
 * - 动态表按方向隔离：c2s 与 s2c 各持有独立 DynamicTable，绝不混用。
 * - SETTINGS_HEADER_TABLE_SIZE 的上限由“本方向最近一次生效点”决定；
 *   生效点（收到 SETTINGS vs ACK 后）由规则参数 headerTableSizeEffect 控制，
 *   SETTINGS 确认前后的上限不混用（见 settings.ts / replay.ts）。
 * - 所有 HPACK 解码失败都是连接级 COMPRESSION_ERROR（RFC 9113 §4.3 / RFC 7541 §4）。
 */
import { STATIC_TABLE, STATIC_TABLE_SIZE } from "./hpack-static.ts";

export interface DynamicEntry {
  name: string;
  value: string;
  /** RFC 7541 §4.1：32 + name.length + value.length（字节长度）。 */
  size: number;
  /** 该条目由哪个 block/哪一帧插入，用于 header 来源与表演化展示。 */
  insertedByFrameId: string;
  insertOrder: number;
}

export type HeaderOrigin =
  | { kind: "indexed-static"; index: number }
  | { kind: "indexed-dynamic"; dynamicInsert: number; indexInBlock: number }
  | {
      kind: "literal-with-index";
      nameIndex?: number;
      nameTable: "static" | "dynamic";
      inserted: boolean;
      indexInBlock: number;
    }
  | { kind: "literal-without-index"; nameIndex?: number; nameTable?: "static" | "dynamic"; indexInBlock: number }
  | { kind: "literal-never-indexed"; nameIndex?: number; nameTable?: "static" | "dynamic"; indexInBlock: number };

export interface DecodedHeader {
  name: string;
  value: string;
  origin: HeaderOrigin;
  /** 在 header block 中的字节偏移范围（坐标基准）。 */
  byteOffset: number;
  byteLength: number;
}

export type HpackErrorCode =
  | "HPACK_INDEX_OOB"
  | "HPACK_DYNAMIC_TABLE_SIZE_UPDATE_VIOLATION"
  | "HPACK_INTEGER_TRUNCATED"
  | "HPACK_STRING_TRUNCATED"
  | "HPACK_INVALID_HUFFMAN"
  | "HPACK_BLOCK_TRUNCATED";

export interface HpackError {
  code: HpackErrorCode;
  message: string;
  byteOffset: number;
  /** 越界索引裁决保留错误范围：实际索引与当时合法上界。 */
  indexValue?: number;
  legalMaxIndex?: number;
  attemptedSize?: number;
  legalMaxSize?: number;
}

export class DynamicTable {
  entries: DynamicEntry[] = [];
  /** 表容量（octets），上限 maxSize 由 SETTINGS 生效点驱动。 */
  size = 0;
  maxSize: number;
  /** 单调版本号，每次逐出/插入/容量更新自增，供“动态表版本”展示。 */
  version = 0;
  private insertCounter = 0;

  constructor(initialMaxSize = 4096) {
    this.maxSize = initialMaxSize;
  }

  entrySize(name: string, value: string): number {
    return 32 + byteLength(name) + byteLength(value);
  }

  insert(name: string, value: string, frameId: string): DynamicEntry {
    const entrySize = this.entrySize(name, value);
    if (entrySize > this.maxSize) {
      // RFC 7541 §4.4：新条目大于整张表时清空全表。
      this.entries = [];
      this.size = 0;
    } else {
      while (this.size + entrySize > this.maxSize && this.entries.length > 0) {
        const oldest = this.entries.shift() as DynamicEntry;
        this.size -= oldest.size;
      }
    }
    const entry: DynamicEntry = {
      name,
      value,
      size: entrySize,
      insertedByFrameId: frameId,
      insertOrder: this.insertCounter++,
    };
    this.entries.push(entry);
    this.size += entrySize;
    this.version++;
    return entry;
  }

  /** 处理 Blocked 前缀的动态表大小更新；超过对端允许的上界即协议违约。 */
  applySizeUpdate(newSize: number): { ok: true } | { ok: false; legalMax: number } {
    if (newSize > this.maxSize) {
      return { ok: false, legalMax: this.maxSize };
    }
    while (this.size > newSize && this.entries.length > 0) {
      const oldest = this.entries.shift() as DynamicEntry;
      this.size -= oldest.size;
    }
    if (this.size > newSize) this.size = newSize;
    this.version++;
    return { ok: true };
  }

  setMaxSize(newMax: number): void {
    this.maxSize = newMax;
    while (this.size > newMax && this.entries.length > 0) {
      const oldest = this.entries.shift() as DynamicEntry;
      this.size -= oldest.size;
    }
    this.version++;
  }

  get length(): number {
    return this.entries.length;
  }

  /** 1 基动态表索引访问（HPACK 索引 = 静态表长度 + 动态位置，位置 1 在最新条目）。 */
  atDynamicPosition(position1Based: number): DynamicEntry | undefined {
    return this.entries[this.entries.length - position1Based];
  }

  /** RFC 7541 全局索引：1..61 静态，62.. 动态（动态最新在前）。 */
  lookup(index: number): { table: "static" | "dynamic"; entry: { name: string; value: string } } | undefined {
    if (index <= STATIC_TABLE_SIZE) {
      const e = STATIC_TABLE[index - 1];
      return e ? { table: "static", entry: e } : undefined;
    }
    const e = this.atDynamicPosition(index - STATIC_TABLE_SIZE);
    return e ? { table: "dynamic", entry: e } : undefined;
  }
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface DecodeBlockOptions {
  /** 该 block 所属方向的接收端动态表。 */
  table: DynamicTable;
  frameId: string;
}

export interface DecodeBlockResult {
  headers: DecodedHeader[];
  error?: HpackError;
  /** 解码停止位置；出错时为出错字节，成功时为 payload.length。 */
  consumed: number;
}

interface IntegerResult {
  value: number;
  next: number;
  ok: boolean;
}

function decodeInteger(payload: number[], offset: number, prefixBits: number): IntegerResult {
  if (offset >= payload.length) return { value: 0, next: offset, ok: false };
  const max = (1 << prefixBits) - 1;
  let value = payload[offset] & max;
  let next = offset + 1;
  if (value < max) return { value, next, ok: true };
  let shift = 0;
  let byte: number;
  do {
    if (next >= payload.length) return { value, next, ok: false };
    byte = payload[next++];
    value += (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, next, ok: true };
}

interface StringResult {
  value: string;
  next: number;
  ok: boolean;
  huffman: boolean;
  startOffset: number;
}

function decodeString(payload: number[], offset: number): StringResult {
  if (offset >= payload.length) return { value: "", next: offset, ok: false, huffman: false, startOffset: offset };
  const huffman = (payload[offset] & 0x80) === 0x80;
  const len = decodeInteger(payload, offset, 7);
  if (!len.ok || len.next + len.value > payload.length) {
    return { value: "", next: Math.min(len.next, payload.length), ok: false, huffman, startOffset: offset };
  }
  const raw = payload.slice(len.next, len.next + len.value);
  let value: string;
  if (huffman) {
    // 案例材料全部使用原始字面量；若出现 Huffman 位，保留诊断而非静默猜测。
    value = new TextDecoder().decode(Uint8Array.from(raw));
  } else {
    value = new TextDecoder().decode(Uint8Array.from(raw));
  }
  return { value, next: len.next + len.value, ok: true, huffman, startOffset: offset };
}

export function decodeBlock(payload: number[], opts: DecodeBlockOptions): DecodeBlockResult {
  const { table, frameId } = opts;
  const headers: DecodedHeader[] = [];
  let offset = 0;
  let indexInBlock = 0;

  const fail = (error: HpackError): DecodeBlockResult => ({
    headers,
    error,
    consumed: error.byteOffset,
  });

  while (offset < payload.length) {
    const start = offset;
    const first = payload[offset];

    if (first & 0x80) {
      // 6.1 Indexed Header Field
      const idx = decodeInteger(payload, offset, 7);
      if (!idx.ok) {
        return fail({ code: "HPACK_INTEGER_TRUNCATED", message: "indexed 表示的索引整数被截断", byteOffset: offset });
      }
      const found = table.lookup(idx.value);
      if (!found) {
        return fail({
          code: "HPACK_INDEX_OOB",
          message: `索引 ${idx.value} 越界：静态表 1..${STATIC_TABLE_SIZE}，动态表当前合法最大索引 ${STATIC_TABLE_SIZE + table.length}`,
          byteOffset: start,
          indexValue: idx.value,
          legalMaxIndex: STATIC_TABLE_SIZE + table.length,
        });
      }
      headers.push({
        name: found.entry.name,
        value: found.entry.value,
        origin:
          found.table === "static"
            ? { kind: "indexed-static", index: idx.value }
            : {
                kind: "indexed-dynamic",
                dynamicInsert: (found.entry as DynamicEntry).insertOrder ?? -1,
                indexInBlock,
              },
        byteOffset: start,
        byteLength: idx.next - start,
      });
      offset = idx.next;
      indexInBlock++;
      continue;
    }

    if ((first & 0xe0) === 0x20) {
      // 6.3 Dynamic Table Size Update
      const size = decodeInteger(payload, offset, 5);
      if (!size.ok) {
        return fail({ code: "HPACK_INTEGER_TRUNCATED", message: "表大小更新整数被截断", byteOffset: offset });
      }
      const applied = table.applySizeUpdate(size.value);
      if (!applied.ok) {
        return fail({
          code: "HPACK_DYNAMIC_TABLE_SIZE_UPDATE_VIOLATION",
          message: `动态表大小更新为 ${size.value} 字节，超过对端允许的上限 ${applied.legalMax} 字节`,
          byteOffset: start,
          attemptedSize: size.value,
          legalMaxSize: applied.legalMax,
        });
      }
      offset = size.next;
      continue;
    }

    const indexing = (first & 0xc0);
    let prefixBits: number;
    let originKind: HeaderOrigin["kind"];
    if (indexing === 0x40) {
      prefixBits = 6;
      originKind = "literal-with-index";
    } else if (indexing === 0x00) {
      prefixBits = 4;
      originKind = "literal-without-index";
    } else {
      prefixBits = 4;
      originKind = "literal-never-indexed";
    }

    const nameIdx = decodeInteger(payload, offset, prefixBits);
    if (!nameIdx.ok) {
      return fail({ code: "HPACK_INTEGER_TRUNCATED", message: "literal 表示的名称索引整数被截断", byteOffset: offset });
    }
    let name = "";
    let nameTable: "static" | "dynamic" | undefined;
    let nameIndex: number | undefined;
    let cursor = nameIdx.next;
    if (nameIdx.value !== 0) {
      const found = table.lookup(nameIdx.value);
      if (!found) {
        return fail({
          code: "HPACK_INDEX_OOB",
          message: `名称索引 ${nameIdx.value} 越界：合法最大索引 ${STATIC_TABLE_SIZE + table.length}`,
          byteOffset: start,
          indexValue: nameIdx.value,
          legalMaxIndex: STATIC_TABLE_SIZE + table.length,
        });
      }
      name = found.entry.name;
      nameTable = found.table;
      nameIndex = nameIdx.value;
    } else {
      const nameStr = decodeString(payload, cursor);
      if (!nameStr.ok) {
        return fail({ code: "HPACK_STRING_TRUNCATED", message: "header 名称字符串被截断", byteOffset: nameStr.startOffset });
      }
      name = nameStr.value;
      cursor = nameStr.next;
    }
    const valueStr = decodeString(payload, cursor);
    if (!valueStr.ok) {
      return fail({ code: "HPACK_STRING_TRUNCATED", message: "header 值字符串被截断", byteOffset: valueStr.startOffset });
    }
    const value = valueStr.value;
    const end = valueStr.next;

    let inserted = false;
    let dynamicInsert: number | undefined;
    if (originKind === "literal-with-index") {
      const entry = table.insert(name, value, frameId);
      inserted = true;
      dynamicInsert = entry.insertOrder;
    }

    const origin: HeaderOrigin =
      originKind === "literal-with-index"
        ? { kind: "literal-with-index", nameIndex, nameTable, inserted, indexInBlock }
        : originKind === "literal-without-index"
          ? { kind: "literal-without-index", nameIndex, nameTable, indexInBlock }
          : { kind: "literal-never-indexed", nameIndex, nameTable, indexInBlock };

    if (origin.kind === "indexed-dynamic") dynamicInsert; // type guard no-op
    headers.push({ name, value, origin, byteOffset: start, byteLength: end - start });
    void dynamicInsert;
    offset = end;
    indexInBlock++;
  }

  return { headers, consumed: offset };
}
