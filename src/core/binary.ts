import type { FrameType, RawFrame } from './types.ts'
import { FRAME_TYPES } from '../case/frames.ts'

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseFrameHex(id: string, materialId: string, ordinal: number, segmentId: string, direction: 'request' | 'response', rawHex: string, offsetOctets: number, sourceCoordinate: string, note?: string): RawFrame {
  const clean = rawHex.replace(/\s+/g, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  const view = new DataView(bytes.buffer)
  const length = view.getUint32(0)
  const rawType = bytes[4]
  const flags = bytes[5]
  const streamId = view.getUint32(6) & 0x7fffffff
  const payload = bytes.slice(9, 9 + Math.min(length, bytes.length - 9))
  return {
    id,
    materialId,
    ordinal,
    segmentId,
    connectionDirection: direction,
    type: (FRAME_TYPES[rawType] as FrameType | undefined) ?? 'RAW',
    rawType,
    flags,
    streamId,
    payloadHex: bytesToHex(payload),
    rawHex: clean,
    offset: { value: offsetOctets, unit: 'octet-offset', basis: 'frame-offset', coordinate: `${segmentId}:byte=${offsetOctets}` },
    length: { value: bytes.length, unit: 'octets', basis: 'frame-offset', coordinate: `${id}.wire-length` },
    sourceCoordinate,
    note
  }
}

export function decodeInteger(bytes: Uint8Array, start: number, prefixBits: number): { value: number; next: number } {
  const max = (1 << prefixBits) - 1
  let index = start
  let value = bytes[index] & max
  if (value < max) return { value, next: index + 1 }
  let multiplier = 1
  index += 1
  while (index < bytes.length) {
    const current = bytes[index]
    value += (current & 127) * multiplier
    index += 1
    if ((current & 128) === 0) return { value, next: index }
    multiplier *= 128
  }
  return { value: -1, next: index }
}

export function uint16(value: number): string {
  return value.toString(16).padStart(4, '0')
}

export function uint32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

export function settingsPayload(entries: Array<[number, number]>): string {
  return entries.map(([id, value]) => uint16(id) + uint32(value)).join('')
}

export function stableHash(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}
