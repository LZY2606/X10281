/**
 * HPACK 编码器（只用于离线案例包的确定性材料构造）。
 * 支持整数、原始（非 Huffman）字符串、静态/动态索引与 literal-with-index。
 */

export function encodeInteger(value: number, prefixBits: number, prefixByte: number): number[] {
  const max = (1 << prefixBits) - 1;
  const out: number[] = [];
  if (value < max) {
    out.push(prefixByte | value);
    return out;
  }
  out.push(prefixByte | max);
  value -= max;
  while (value >= 128) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

export function encodeRawString(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...encodeInteger(bytes.length, 7, 0x00), ...bytes];
}

export function indexed(index: number): number[] {
  return encodeInteger(index, 7, 0x80);
}

export function literalWithIndexing(nameIndex: number, value: string): number[] {
  return [...encodeInteger(nameIndex, 6, 0x40), ...encodeRawString(value)];
}

export function literalWithIndexingName(name: string, value: string): number[] {
  return [0x40, ...encodeRawString(name), ...encodeRawString(value)];
}

export function literalWithoutIndexing(nameIndex: number, value: string): number[] {
  return [...encodeInteger(nameIndex, 4, 0x00), ...encodeRawString(value)];
}

export function sizeUpdate(size: number): number[] {
  return encodeInteger(size, 5, 0x20);
}

/** 按 RFC 7541 §4.1 计算条目表占用。 */
export function entrySize(name: string, value: string): number {
  return 32 + new TextEncoder().encode(name).length + new TextEncoder().encode(value).length;
}
