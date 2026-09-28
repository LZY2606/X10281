import { STATIC_TABLE, STATIC_TABLE_SIZE } from "./static-table.ts";
import type { HeaderField } from "./types.ts";

/* ------------------------------ 整数编解码 ------------------------------ */

export function encodeInteger(value: number, prefixBits: number, firstBytePrefix: number): number[] {
  const max = (1 << prefixBits) - 1;
  if (value < max) return [firstBytePrefix | value];
  const out = [firstBytePrefix | max];
  let rest = value - max;
  while (rest >= 128) {
    out.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

export interface IntResult {
  value: number;
  next: number;
}

export function decodeInteger(buf: Uint8Array, offset: number, prefixBits: number, prefixValue: number): IntResult {
  const max = (1 << prefixBits) - 1;
  if (prefixValue < max) return { value: prefixValue, next: offset };
  let value = max;
  let shift = 0;
  let i = offset;
  while (true) {
    if (i >= buf.length) throw new HpackError("INTEGER_TRUNCATED", "HPACK 整数编码被截断");
    const b = buf[i]!;
    i += 1;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: i };
}

/* ------------------------------ 字符串编解码 ----------------------------- */

export function encodeString(s: string): number[] {
  const bytes = new TextEncoder().encode(s);
  return [...encodeInteger(bytes.length, 7, 0), ...bytes];
}

export interface StrResult {
  value: string;
  huffman: boolean;
  diagnostic?: string;
  next: number;
}

export function decodeString(buf: Uint8Array, offset: number): StrResult {
  if (offset >= buf.length) throw new HpackError("STRING_TRUNCATED", "HPACK 字符串长度前缀被截断");
  const first = buf[offset]!;
  const huffman = (first & 0x80) !== 0;
  const len = decodeInteger(buf, offset + 1, 7, first & 0x7f);
  const end = len.next + len.value;
  if (end > buf.length) throw new HpackError("STRING_TRUNCATED", "HPACK 字符串长度超出 block 边界");
  const raw = buf.slice(len.next, end);
  if (huffman) {
    // 不丢弃：保留原始字节位置并附诊断，规范化层不得伪造值。
    return {
      value: bytesToHex(raw),
      huffman: true,
      diagnostic: "huffman-encoded-value-kept-as-rawhex",
      next: end,
    };
  }
  return { value: new TextDecoder().decode(raw), huffman: false, next: end };
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new HpackError("HEX_ODD", "十六进制长度为奇数");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* -------------------------------- 错误类型 -------------------------------- */

export class HpackError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HpackError";
  }
}

/* ------------------------------ 动态表解码状态 ----------------------------- */

export interface DynamicRow {
  name: string;
  value: string;
  size: number;
  insertedAtFrameId: string;
}

/** 单个方向的 HPACK 解码上下文。不同方向必须各自持有实例（表按方向隔离）。 */
export class HpackDecoderContext {
  /** 动态表：索引 0 是最新插入项（对应 RFC 动态表第一行）。 */
  dynamic: DynamicRow[] = [];
  dynamicSize = 0;
  /** 对端 SETTINGS_HEADER_TABLE_SIZE 通告并已生效（收到即生效）的上限。 */
  settingsMax: number;
  /** 动态表大小上限，初始等于 4096 或首个 SETTINGS。 */
  currentMax: number;

  constructor(settingsMax = 4096) {
    this.settingsMax = settingsMax;
    this.currentMax = settingsMax;
  }

  lookup(hpackIndex: number): { name: string; value: string } {
    if (hpackIndex < 1) throw new HpackError("INDEX_ZERO", "HPACK 索引必须为正整数");
    if (hpackIndex <= STATIC_TABLE_SIZE) {
      const e = STATIC_TABLE[hpackIndex - 1]!;
      return { name: e.name, value: e.value };
    }
    const di = hpackIndex - STATIC_TABLE_SIZE - 1;
    const row = this.dynamic[di];
    if (!row) throw new HpackError("INDEX_OUTOFRANGE", `HPACK 索引 ${hpackIndex} 越界：动态表仅 ${this.dynamic.length} 项`);
    return { name: row.name, value: row.value };
  }

  private entrySize(name: string, value: string): number {
    return new TextEncoder().encode(name).length + new TextEncoder().encode(value).length + 32;
  }

  addEntry(name: string, value: string, frameId: string): void {
    const size = this.entrySize(name, value);
    if (size > this.currentMax) {
      // RFC 7541 §4.4：新条目本身大于表上限时，表被清空（非错误）。
      this.dynamic = [];
      this.dynamicSize = 0;
      return;
    }
    while (this.dynamicSize + size > this.currentMax && this.dynamic.length > 0) {
      const evicted = this.dynamic.pop()!;
      this.dynamicSize -= evicted.size;
    }
    this.dynamic.unshift({ name, value, size, insertedAtFrameId: frameId });
    this.dynamicSize += size;
  }

  applySizeUpdate(newMax: number): void {
    // RFC 7541 §4.2：动态表大小更新不得超过 SETTINGS_HEADER_TABLE_SIZE，否则 COMPRESSION_ERROR。
    if (newMax > this.settingsMax) {
      throw new HpackError("TABLE_SIZE_LIMIT", `动态表大小更新 ${newMax} 超过 SETTINGS 上限 ${this.settingsMax}`);
    }
    this.currentMax = newMax;
    while (this.dynamicSize > this.currentMax && this.dynamic.length > 0) {
      const evicted = this.dynamic.pop()!;
      this.dynamicSize -= evicted.size;
    }
  }

  /** SETTINGS_HEADER_TABLE_SIZE 收到即对解码侧生效（ACK 只确认收讫，不改变该上限的生效点）。 */
  noteSettingsMax(newMax: number): void {
    this.settingsMax = newMax;
  }
}

/* ------------------------------- block 解码 ------------------------------- */

export interface DecodeResult {
  headers: HeaderField[];
  /** 解码在第几个 header 表示上终止（含错误字段的原始字节）。 */
  errorCode?: string;
  errorMessage?: string;
  failedAtOrdinal?: number;
}

export function decodeHeaderBlock(ctx: HpackDecoderContext, hex: string, frameId: string): DecodeResult {
  const buf = hexToBytes(hex);
  const headers: HeaderField[] = [];
  let i = 0;
  let ordinal = 0;
  try {
    while (i < buf.length) {
      const start = i;
      const b = buf[i]!;
      const rawStart = i;
      if (b & 0x80) {
        // Indexed Header Field（前缀 1）
        const idx = decodeInteger(buf, i + 1, 7, b & 0x7f);
        i = idx.next;
        const e = ctx.lookup(idx.value);
        headers.push({
          name: e.name,
          value: e.value,
          representation: "indexed",
          hpackIndex: idx.value,
          ordinal: ordinal++,
          rawHex: bytesToHex(buf.slice(rawStart, i)),
        });
      } else if ((b & 0xc0) === 0x40) {
        // Literal with Incremental Indexing（前缀 6）
        const nameIdx = decodeInteger(buf, i + 1, 6, b & 0x3f);
        i = nameIdx.next;
        let name: string;
        if (nameIdx.value === 0) {
          const ns = decodeString(buf, i);
          i = ns.next;
          name = ns.value;
        } else {
          name = ctx.lookup(nameIdx.value).name;
        }
        const vs = decodeString(buf, i);
        i = vs.next;
        const value = vs.value;
        headers.push({
          name,
          value,
          representation: "literal-incremental",
          hpackIndex: nameIdx.value === 0 ? null : nameIdx.value,
          ordinal: ordinal++,
          rawHex: bytesToHex(buf.slice(rawStart, i)),
          diagnostic: vs.diagnostic,
        });
        ctx.addEntry(name, value, frameId);
      } else if ((b & 0xe0) === 0x20) {
        // Dynamic Table Size Update（前缀 5）
        const size = decodeInteger(buf, i + 1, 5, b & 0x1f);
        i = size.next;
        ctx.applySizeUpdate(size.value);
        headers.push({
          name: "",
          value: "",
          representation: "dynamic-size-update",
          hpackIndex: null,
          ordinal: ordinal++,
          rawHex: bytesToHex(buf.slice(rawStart, i)),
          diagnostic: `table-size=${size.value}`,
        });
      } else {
        // Literal Without Indexing（前缀 4，0x00）或 Never Indexed（前缀 4，0x10）
        const never = (b & 0xf0) === 0x10;
        const nameIdx = decodeInteger(buf, i + 1, 4, b & 0x0f);
        i = nameIdx.next;
        let name: string;
        if (nameIdx.value === 0) {
          const ns = decodeString(buf, i);
          i = ns.next;
          name = ns.value;
        } else {
          name = ctx.lookup(nameIdx.value).name;
        }
        const vs = decodeString(buf, i);
        i = vs.next;
        headers.push({
          name,
          value: vs.value,
          representation: never ? "literal-never-indexed" : "literal-without-indexing",
          hpackIndex: nameIdx.value === 0 ? null : nameIdx.value,
          ordinal: ordinal++,
          rawHex: bytesToHex(buf.slice(rawStart, i)),
          diagnostic: vs.diagnostic,
        });
      }
    }
    return { headers };
  } catch (err) {
    if (err instanceof HpackError) {
      return {
        headers,
        errorCode: err.code,
        errorMessage: err.message,
        failedAtOrdinal: ordinal,
      };
    }
    throw err;
  }
}

/* ------------------------------- block 编码 ------------------------------- */

export function encodeIndexed(hpackIndex: number): number[] {
  return encodeInteger(hpackIndex, 7, 0x80);
}

export function encodeLiteralIncremental(hpackIndex: number | null, name: string, value: string): number[] {
  const out: number[] = [];
  if (hpackIndex === null) {
    out.push(...encodeInteger(0, 6, 0x40));
    out.push(...encodeString(name));
  } else {
    out.push(...encodeInteger(hpackIndex, 6, 0x40));
  }
  out.push(...encodeString(value));
  return out;
}

export function encodeLiteralNoIndex(hpackIndex: number | null, name: string, value: string): number[] {
  const out: number[] = [];
  if (hpackIndex === null) {
    out.push(0x00);
    out.push(...encodeString(name));
  } else {
    out.push(...encodeInteger(hpackIndex, 4, 0x00));
  }
  out.push(...encodeString(value));
  return out;
}

export function encodeSizeUpdate(newMax: number): number[] {
  return encodeInteger(newMax, 5, 0x20);
}
