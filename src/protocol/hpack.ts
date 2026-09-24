import { STATIC_TABLE } from './data/static-table.js';
import { HUFFMAN_CODES } from './data/huffman-codes.js';
import { ProtocolDecodeError } from './errors.js';
import type { DecodedHeader, HeaderOriginKind } from '../shared/types.js';

const STATIC_TABLE_SIZE = STATIC_TABLE.length;

export interface HpackEntry {
  name: string;
  value: string;
}

export interface HpackTableSnapshotEntry extends HpackEntry {
  entrySize: number;
}

/** RFC 7541 §4.1 entry size. */
export function entrySize(name: string, value: string): number {
  return Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 32;
}

/**
 * Per-direction HPACK decoder dynamic table.
 * Confirmed vs pending maxima are kept separately so SETTINGS ACK timing
 * never silently mixes the two limits.
 */
export class HpackDynamicTable {
  private entries: HpackTableSnapshotEntry[] = [];
  private currentSize = 0;
  private capacity: number;
  /** Maximum acknowledged by the decoder via SETTINGS ACK (RFC 7541 §4.2). */
  confirmedMax: number;
  /** Maximum carried by the latest SETTINGS but not yet acknowledged (null = none pending). */
  pendingMax: number | null = null;

  constructor(confirmedMax = 4096) {
    this.confirmedMax = confirmedMax;
    this.capacity = confirmedMax;
  }

  get size(): number {
    return this.currentSize;
  }

  get maxCapacity(): number {
    return this.capacity;
  }

  snapshotEntries(): HpackTableSnapshotEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Apply the table-size update at the start of a header block (RFC 7541 §4.2, §6.3). */
  applySizeUpdate(newMax: number): void {
    if (newMax > this.capacity) {
      throw new ProtocolDecodeError(
        'COMPRESSION_ERROR',
        'connection',
        'hpack.size-update-exceeds-settings',
        'RFC 7541 §4.2; RFC 9113 §10.2.2',
        `dynamic table size update ${newMax} exceeds acknowledged SETTINGS_HEADER_TABLE_SIZE ${this.capacity}`,
      );
    }
    this.capacity = newMax;
    this.evictUntilFits();
  }

  /** A SETTINGS frame carrying HEADER_TABLE_SIZE arrives from the peer (pending on this decoder). */
  settingsReceived(value: number): void {
    this.pendingMax = value;
  }

  /** SETTINGS ACK received: the peer accepted our advertised limit; pending becomes confirmed. */
  settingsAcked(): void {
    if (this.pendingMax !== null) {
      this.confirmedMax = this.pendingMax;
      this.pendingMax = null;
    }
  }

  /** Look up an absolute 1-based HPACK index (static then dynamic). */
  lookup(absoluteIndex: number): HpackEntry {
    if (absoluteIndex < 1) {
      throw new ProtocolDecodeError(
        'COMPRESSION_ERROR', 'connection', 'hpack.index-out-of-range',
        'RFC 7541 §6.1', `invalid HPACK index ${absoluteIndex}`,
      );
    }
    if (absoluteIndex <= STATIC_TABLE_SIZE) {
      const entry = STATIC_TABLE[absoluteIndex - 1]!;
      return { name: entry.name, value: entry.value };
    }
    const dynIndex = absoluteIndex - STATIC_TABLE_SIZE;
    if (dynIndex > this.entries.length) {
      throw new ProtocolDecodeError(
        'COMPRESSION_ERROR', 'connection', 'hpack.index-out-of-dynamic-table',
        'RFC 7541 §6.1',
        `HPACK index ${absoluteIndex} (dynamic ${dynIndex}) exceeds dynamic table length ${this.entries.length}`,
      );
    }
    const entry = this.entries[dynIndex - 1]!;
    return { name: entry.name, value: entry.value };
  }

  isStaticIndex(absoluteIndex: number): boolean {
    return absoluteIndex >= 1 && absoluteIndex <= STATIC_TABLE_SIZE;
  }

  add(entry: HpackEntry): void {
    const size = entrySize(entry.name, entry.value);
    if (size > this.capacity) {
      // RFC 7541 §4.4: entries larger than the table size evict everything and are not inserted.
      this.entries = [];
      this.currentSize = 0;
      return;
    }
    this.entries.unshift({ ...entry, entrySize: size });
    this.currentSize += size;
    this.evictUntilFits();
  }

  private evictUntilFits(): void {
    while (this.currentSize > this.capacity && this.entries.length > 0) {
      const evicted = this.entries.pop()!;
      this.currentSize -= evicted.entrySize;
    }
    if (this.currentSize < 0) this.currentSize = 0;
  }
}

export interface DecodeResult {
  headers: DecodedHeader[];
  /** Decoder-side dynamic table size updates seen at block start (octets), in order. */
  sizeUpdates: number[];
  /** Absolute HPACK indices referenced by indexed representations. */
  referencedIndices: { index: number; static: boolean }[];
}

class ByteReader {
  pos = 0;
  constructor(private readonly buf: Buffer, readonly startOffset = 0) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** RFC 7541 §5.1 integer representation. */
  readInteger(prefixBits: number): number {
    if (this.pos >= this.buf.length) {
      throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.truncated-integer',
        'RFC 7541 §5.1', 'truncated header block: expected integer prefix byte');
    }
    const maxPrefix = (1 << prefixBits) - 1;
    const first = this.buf[this.pos]!;
    let value = first & maxPrefix;
    this.pos += 1;
    if (value < maxPrefix) return value;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) {
        throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.truncated-integer',
          'RFC 7541 §5.1', 'truncated header block: incomplete integer continuation');
      }
      const b = this.buf[this.pos]!;
      this.pos += 1;
      if (shift >= 32 || value + ((b & 0x7f) * 2 ** shift) > 0xffffffff) {
        throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.integer-overflow',
          'RFC 7541 §5.1', 'HPACK integer exceeds 2^32-1');
      }
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
    }
  }

  /** RFC 7541 §5.2 string literal. */
  readString(): { value: string; huffman: boolean; byteLength: number } {
    const start = this.pos;
    const huffman = (this.peekByte() & 0x80) !== 0;
    const length = this.readInteger(7);
    if (this.remaining < length) {
      throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.truncated-string',
        'RFC 7541 §5.2', `truncated header block: string needs ${length} octets, ${this.remaining} remain`);
    }
    const raw = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    let value: string;
    if (huffman) {
      value = huffmanDecode(raw);
    } else {
      value = raw.toString('utf8');
    }
    return { value, huffman, byteLength: this.pos - start };
  }

  peekByte(): number {
    if (this.pos >= this.buf.length) {
      throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.truncated-block',
        'RFC 7541 §6', 'truncated header block: expected representation byte');
    }
    return this.buf[this.pos]!;
  }
}

/** RFC 7541 §5.2 Huffman decode (canonical codes from Appendix B). */
export function huffmanDecode(raw: Buffer): string {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < raw.length; i++) {
    acc = (acc << 8) | raw[i]!;
    bits += 8;
    // Greedy longest-prefix match over a small canonical-code table.
    for (;;) {
      const matched = matchHuffman(acc, bits);
      if (matched === null) break;
      if (matched.symbol === 256) {
        throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.eos-symbol',
          'RFC 7541 §5.2', 'Huffman-encoded string contains the EOS symbol');
      }
      out.push(matched.symbol);
      bits -= matched.len;
      acc &= 2 ** bits - 1;
    }
  }
  // Padding validation: remaining bits must be the most-significant bits of the EOS code (all 1s),
  // strictly fewer than the shortest code length (5).
  if (bits > 0) {
    if (bits >= 8) {
      throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.bad-padding',
        'RFC 7541 §5.2', `Huffman padding too long: ${bits} residual bits`);
    }
    const eos = HUFFMAN_CODES[256]!;
    const topEos = eos[1] >>> (eos[0] - bits);
    if (acc !== topEos) {
      throw new ProtocolDecodeError('COMPRESSION_ERROR', 'connection', 'hpack.bad-padding',
        'RFC 7541 §5.2', 'Huffman padding does not match EOS prefix');
    }
  }
  return Buffer.from(out).toString('utf8');
}

function matchHuffman(acc: number, bits: number): { symbol: number; len: number } | null {
  let best: { symbol: number; len: number } | null = null;
  for (let symbol = 0; symbol < HUFFMAN_CODES.length; symbol++) {
    const [len, code] = HUFFMAN_CODES[symbol]!;
    if (len > bits) continue;
    const top = acc >>> (bits - len);
    if (top === code) {
      if (!best || len > best.len) best = { symbol, len };
    }
  }
  return best;
}

/**
 * Decode a concatenated header block (HEADERS payload + CONTINUATION fragments,
 * padding/priority already stripped by the frame layer).
 */
export function decodeHeaderBlock(block: Buffer, table: HpackDynamicTable): DecodeResult {
  const reader = new ByteReader(block);
  const headers: DecodedHeader[] = [];
  const sizeUpdates: number[] = [];
  const referencedIndices: { index: number; static: boolean }[] = [];

  while (reader.remaining > 0) {
    const repStart = reader.pos;
    const b = reader.peekByte();

    // §6.3 dynamic table size update.
    if ((b & 0xe0) === 0x20) {
      const newSize = reader.readInteger(5);
      table.applySizeUpdate(newSize);
      sizeUpdates.push(newSize);
      headers.push({
        name: '', value: '', blockOffset: repStart, length: reader.pos - repStart,
        huffmanName: false, huffmanValue: false, origin: 'dynamic-size-update',
      });
      continue;
    }

    // §6.1 indexed header field.
    if ((b & 0x80) !== 0) {
      const index = reader.readInteger(7);
      const entry = table.lookup(index);
      referencedIndices.push({ index, static: table.isStaticIndex(index) });
      headers.push({
        name: entry.name, value: entry.value, blockOffset: repStart, length: reader.pos - repStart,
        huffmanName: false, huffmanValue: false,
        origin: table.isStaticIndex(index) ? 'static' : 'dynamic',
        tableIndex: index,
      });
      continue;
    }

    // §6.2.1 / §6.2.2 / §6.2.3 literal representations.
    let origin: HeaderOriginKind;
    let incremental = false;
    if ((b & 0xc0) === 0x40) {
      origin = 'literal-incremental';
      incremental = true;
    } else if ((b & 0xf0) === 0x10) {
      origin = 'literal-never-indexed';
    } else {
      origin = 'literal-without-indexing';
    }
    const nameIndexBits = incremental ? 6 : 4;
    const nameIndex = reader.readInteger(nameIndexBits);
    let name: string;
    let nameHuff = false;
    if (nameIndex !== 0) {
      const ref = table.lookup(nameIndex);
      name = ref.name;
    } else {
      const s = reader.readString();
      name = s.value;
      nameHuff = s.huffman;
    }
    const valueStr = reader.readString();
    const repLen = reader.pos - repStart;
    if (incremental) {
      table.add({ name, value: valueStr.value });
    }
    headers.push({
      name, value: valueStr.value, blockOffset: repStart, length: repLen,
      huffmanName: nameHuff, huffmanValue: valueStr.huffman, origin,
      tableIndex: nameIndex !== 0 ? nameIndex : undefined,
    });
  }

  return { headers, sizeUpdates, referencedIndices };
}

/** RFC 7541 §5.1 integer encode (used by the fixture builder). */
export function encodeInteger(value: number, prefixBits: number, prefixMask: number): Buffer {
  const maxPrefix = (1 << prefixBits) - 1;
  if (value < maxPrefix) return Buffer.from([prefixMask | value]);
  const bytes = [prefixMask | maxPrefix];
  let rest = value - maxPrefix;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

export function encodeString(value: string | Buffer, huffman = false): Buffer {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const head = encodeInteger(payload.length | (huffman ? 0x80 : 0), 7, 0);
  return Buffer.concat([head, payload]);
}
