import { decodeInteger, entrySize, hexToBytes } from './binary-helpers.ts'
import type { HeaderEntry } from './types.ts'

export interface HpackResult {
  headers: HeaderEntry[]
  newEntries: HeaderEntry[]
  sizeUpdate: number | null
  error: string | null
}

const staticNames: Record<number, string> = {
  2: ':method',
  3: ':method',
  4: ':path',
  5: ':path',
  6: ':scheme',
  8: ':status',
  62: ':authority'
}
const staticValues: Record<number, string> = { 2: 'GET', 3: 'POST', 4: '/', 5: '/index.html', 6: 'http', 8: '200' }

function readString(bytes: Uint8Array, start: number): { value: string; next: number } | null {
  const length = decodeInteger(bytes, start, 7)
  if (length.value < 0 || length.next > bytes.length) return null
  const raw = bytes.slice(length.next, length.next + length.value)
  if (raw.length !== length.value) return null
  return { value: new TextDecoder().decode(raw), next: length.next + length.value }
}

export function decodeHeaderBlock(payloadHex: string, dynamicEntries: HeaderEntry[], capacity: number, frameId: string, startPosition: number): HpackResult {
  const bytes = hexToBytes(payloadHex)
  const headers: HeaderEntry[] = []
  const newEntries: HeaderEntry[] = []
  let entries = [...dynamicEntries]
  let size = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  let position = startPosition
  let cursor = 0
  let sizeUpdate: number | null = null

  while (cursor < bytes.length) {
    const first = bytes[cursor]
    if ((first & 0x80) === 0x80) {
      const index = decodeInteger(bytes, cursor, 7)
      cursor = index.next
      if (index.value <= 0 || index.value > 61 + entries.length) {
        return { headers, newEntries, sizeUpdate, error: 'HPACK_INDEX_OUT_OF_RANGE' }
      }
      const source = index.value <= 61
        ? { name: staticNames[index.value] ?? `static-${index.value}`, value: staticValues[index.value] ?? '' }
        : entries[61 + entries.length - index.value]
      headers.push({
        id: `H-${frameId}-${position}`,
        name: source.name,
        value: source.value,
        sourceType: index.value <= 61 ? 'static' : 'dynamic',
        sourceIndex: index.value,
        sourceFrameId: frameId,
        sourceBlockPosition: position
      })
      position += 1
      continue
    }

    if ((first & 0xe0) === 0x20) {
      const decoded = decodeInteger(bytes, cursor, 5)
      cursor = decoded.next
      if (decoded.value < 0 || decoded.value > capacity) {
        return { headers, newEntries, sizeUpdate: decoded.value, error: decoded.value > capacity ? 'HPACK_TABLE_SIZE_UPDATE_EXCEEDS_ACKED_LIMIT' : 'HPACK_INTEGER_TRUNCATED' }
      }
      sizeUpdate = decoded.value
      size = decoded.value
      entries = []
      continue
    }

    const incremental = (first & 0xc0) === 0x40
    const nameBits = incremental ? 6 : 4
    const highMask = incremental ? 0x40 : 0x00
    const nameInteger = decodeInteger(bytes, cursor, nameBits)
    cursor = nameInteger.next
    let name = ''
    let nameIndex: number | null = null
    if (nameInteger.value > 0) {
      nameIndex = nameInteger.value
      name = nameInteger.value <= 61 ? staticNames[nameInteger.value] ?? `static-${nameInteger.value}` : entries[61 + entries.length - nameInteger.value].name
    } else {
      const nameString = readString(bytes, cursor)
      if (!nameString) return { headers, newEntries, sizeUpdate, error: 'HPACK_NAME_TRUNCATED' }
      name = nameString.value
      cursor = nameString.next
    }

    const valueString = readString(bytes, cursor)
    if (!valueString) return { headers, newEntries, sizeUpdate, error: 'HPACK_VALUE_TRUNCATED' }
    cursor = valueString.next
    const entry: HeaderEntry = {
      id: `H-${frameId}-${position}`,
      name,
      value: valueString.value,
      sourceType: incremental ? 'incremental' : 'literal',
      sourceIndex: nameIndex,
      sourceFrameId: frameId,
      sourceBlockPosition: position
    }
    headers.push(entry)
    if (incremental) {
      const tableEntry: HeaderEntry = { ...entry, id: `DT-entry-${frameId}-${position}`, size: entrySize(name, valueString.value) }
      if (tableEntry.size! > capacity) {
        newEntries.push(tableEntry)
        return { headers, newEntries, sizeUpdate, error: 'HPACK_ENTRY_EXCEEDS_TABLE_CAPACITY' }
      }
      size += tableEntry.size!
      entries = [tableEntry, ...entries]
      while (size > capacity && entries.length) {
        const removed = entries.pop()!
        size -= removed.size ?? 0
      }
      entries.forEach((existing, idx) => { existing.dynamicTablePosition = idx + 1 })
      newEntries.push(tableEntry)
    }
    position += 1
  }
  return { headers, newEntries, sizeUpdate, error: null }
}
