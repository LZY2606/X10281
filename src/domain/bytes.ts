export type Byte = number;

export function bytesToHex(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

export function concatBytes(parts: ArrayLike<number>[]): number[] {
  const out: number[] = [];
  for (const part of parts) for (let i = 0; i < part.length; i++) out.push(part[i] & 0xff);
  return out;
}

export function sliceBytes(bytes: ArrayLike<number>, start: number, end?: number): number[] {
  const e = end === undefined ? bytes.length : Math.min(end, bytes.length);
  const s = Math.max(0, start);
  const out: number[] = [];
  for (let i = s; i < e; i++) out.push(bytes[i] & 0xff);
  return out;
}

/**
 * 保留原始表示地解析十六进制文本。允许空白/制表/换行；奇数字面量或非 hex
 * 字符不丢弃，返回诊断；无法成对的半字节留在原位（补 0 并标记）。
 */
export interface ParseHexResult {
  bytes: number[];
  diagnostics: { offset: number; char: string; reason: string }[];
  oddTail: boolean;
}

export function parseHexLenient(hex: string): ParseHexResult {
  const bytes: number[] = [];
  const diagnostics: ParseHexResult["diagnostics"] = [];
  let hi: number | null = null;
  let nibbleOffset = 0;
  for (let i = 0; i < hex.length; i++) {
    const ch = hex[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ":") continue;
    const v = parseNibble(ch);
    if (v < 0) {
      diagnostics.push({ offset: i, char: ch, reason: "non-hexadecimal character" });
      continue;
    }
    if (hi === null) {
      hi = v;
    } else {
      bytes.push((hi << 4) | v);
      hi = null;
    }
    nibbleOffset++;
  }
  const oddTail = hi !== null;
  if (oddTail) bytes.push((hi as number) << 4);
  return { bytes, diagnostics, oddTail };
}

export function parseNibble(ch: string): number {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "a" && ch <= "f") return ch.charCodeAt(0) - 87;
  if (ch >= "A" && ch <= "F") return ch.charCodeAt(0) - 55;
  return -1;
}

export function uint32(bytes: ArrayLike<number>, offset: number): number {
  return (
    ((bytes[offset] & 0xff) * 0x1000000 +
      (bytes[offset + 1] & 0xff) * 0x10000 +
      (bytes[offset + 2] & 0xff) * 0x100 +
      (bytes[offset + 3] & 0xff)) >>>
    0
  );
}

export function toUint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function u31(value: number): number {
  return value & 0x7fffffff;
}
