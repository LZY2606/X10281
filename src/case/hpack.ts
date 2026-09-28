export function encodeInteger(value: number, prefixBits: number, prefixHighBits: number): number[] {
  const max = (1 << prefixBits) - 1
  if (value < max) return [prefixHighBits | value]
  const bytes = [prefixHighBits | max]
  let rest = value - max
  while (rest >= 128) {
    bytes.push((rest % 128) + 128)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return bytes
}

export function decodeInteger(bytes: Uint8Array, start: number, prefixBits: number): { value: number; next: number } {
  const max = (1 << prefixBits) - 1
  let index = start
  let value = bytes[index] & max
  if (value < max) return { value, next: index + 1 }
  let multiplier = 1
  index += 1
  while (index < bytes.length) {
    const b = bytes[index]
    value += (b & 127) * multiplier
    index += 1
    if ((b & 128) === 0) return { value, next: index }
    multiplier *= 128
  }
  return { value: -1, next: index }
}

export function stringBytes(value: string): number[] {
  const out = new TextEncoder().encode(value)
  return [...encodeInteger(out.length, 7, 0), ...out]
}

export function indexed(index: number): number[] {
  return encodeInteger(index, 7, 0b10000000)
}

export function literalIncremental(indexOrName: number | string, value?: string): number[] {
  let bytes: number[]
  if (typeof indexOrName === 'number') bytes = encodeInteger(indexOrName, 6, 0b01000000)
  else {
    bytes = [0x40, ...stringBytes(indexOrName)]
  }
  if (value !== undefined) bytes.push(...stringBytes(value))
  return bytes
}

export function dynamicTableSizeUpdate(size: number): number[] {
  return encodeInteger(size, 5, 0b00100000)
}

export function entrySize(name: string, value: string): number {
  return new TextEncoder().encode(name).length + new TextEncoder().encode(value).length + 32
}

export function concat(...parts: number[][]): string {
  return parts.flat().map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
